import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { PDF_DOCQA_CHUNKING_FINGERPRINT } from "./parsedBundleMapping.js";
import type { PipelineConfig, RootConfig } from "./types.js";
import type { JournalBinding } from "./journalTypes.js";

const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const AGE_RECIPIENT = /^age1pq1[023456789acdefghjklmnpqrstuvwxyz]{40,4090}$/;
const HOST = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

function fail(message: string): never {
  throw new Error(`Invalid pipeline config: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a nonempty string`);
  return value;
}
function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail(`${label} is out of range`);
  return value as number;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !(field in value)) ||
    Object.keys(value).some((field) => !allowed.has(field))
  ) {
    fail("PDF document-Q&A profile has invalid fields");
  }
}

function absolutePath(value: unknown, label: string): string {
  const path = string(value, label);
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    Buffer.byteLength(path, "utf8") > 4_096
  ) {
    fail(`${label} must be a bounded absolute path`);
  }
  return resolve(path);
}

function sha256(value: unknown, label: string): string {
  const fingerprint = string(value, label);
  if (!SHA256.test(fingerprint)) fail(`${label} must be a SHA-256 digest`);
  return fingerprint;
}

function profileText(value: unknown, label: string): string {
  const text = string(value, label);
  if (
    Buffer.byteLength(text, "utf8") > 1_024 ||
    /[\x00-\x1f\x7f]/.test(text) ||
    text.normalize("NFC") !== text
  ) {
    fail(`${label} is invalid`);
  }
  return text;
}

function recipient(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (
    Buffer.byteLength(parsed, "utf8") > 4_096 ||
    /[\x00-\x1f\x7f]/.test(parsed) ||
    !AGE_RECIPIENT.test(parsed)
  ) {
    fail(`${label} is invalid`);
  }
  return parsed;
}

function passwordCommand(value: unknown): {
  executable: string;
  publicArgs?: string[];
} {
  const command = object(
    value,
    "pdfDocQa.archive.independentBackup.passwordCommand",
  );
  exact(command, ["executable"], ["publicArgs"]);
  const executable = absolutePath(
    command.executable,
    "passwordCommand.executable",
  );
  if (command.publicArgs === undefined) return { executable };
  if (!Array.isArray(command.publicArgs) || command.publicArgs.length > 16) {
    fail("passwordCommand.publicArgs is invalid");
  }
  const publicArgs = command.publicArgs.map((argument, index) => {
    const parsed = profileText(
      argument,
      `passwordCommand.publicArgs[${index}]`,
    );
    if (Buffer.byteLength(parsed, "utf8") > 256) {
      fail("passwordCommand.publicArgs is invalid");
    }
    return parsed;
  });
  return { executable, publicArgs };
}

function archiveIdentity(value: Record<string, unknown>, label: string) {
  exact(value, [
    "archiveProfileFingerprint",
    "archiveIdentityFingerprint",
    "recipientFingerprint",
    "repositoryKeyDomainFingerprint",
    "storageFailureDomainFingerprint",
  ]);
  return {
    archiveProfileFingerprint: sha256(
      value.archiveProfileFingerprint,
      `${label}.archiveProfileFingerprint`,
    ),
    archiveIdentityFingerprint: sha256(
      value.archiveIdentityFingerprint,
      `${label}.archiveIdentityFingerprint`,
    ),
    recipientFingerprint: sha256(
      value.recipientFingerprint,
      `${label}.recipientFingerprint`,
    ),
    repositoryKeyDomainFingerprint: sha256(
      value.repositoryKeyDomainFingerprint,
      `${label}.repositoryKeyDomainFingerprint`,
    ),
    storageFailureDomainFingerprint: sha256(
      value.storageFailureDomainFingerprint,
      `${label}.storageFailureDomainFingerprint`,
    ),
  };
}

function containsPath(parent: string, candidate: string): boolean {
  return parent === "/"
    ? candidate.startsWith("/")
    : candidate === parent || candidate.startsWith(`${parent}/`);
}

function overlaps(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function pdfDocQa(value: unknown, roots: RootConfig[], journalDir: string) {
  const input = object(value, "pdfDocQa");
  exact(input, [
    "captureDirectory",
    "parserOutputRoot",
    "spoolDirectory",
    "parser",
    "profile",
    "archive",
  ]);
  const captureDirectory = absolutePath(
    input.captureDirectory,
    "pdfDocQa.captureDirectory",
  );
  const parserOutputRoot = absolutePath(
    input.parserOutputRoot,
    "pdfDocQa.parserOutputRoot",
  );
  const spoolDirectory = absolutePath(
    input.spoolDirectory,
    "pdfDocQa.spoolDirectory",
  );
  const parserInput = object(input.parser, "pdfDocQa.parser");
  exact(parserInput, [
    "pythonExecutable",
    "expectedPythonSha256",
    "launcherPath",
    "expectedLauncherSha256",
    "packageRoot",
    "modelAssetsPath",
    "modelLockPath",
    "expectedModelLockSha256",
  ]);
  const parser = {
    pythonExecutable: absolutePath(
      parserInput.pythonExecutable,
      "pdfDocQa.parser.pythonExecutable",
    ),
    expectedPythonSha256: sha256(
      parserInput.expectedPythonSha256,
      "pdfDocQa.parser.expectedPythonSha256",
    ),
    launcherPath: absolutePath(
      parserInput.launcherPath,
      "pdfDocQa.parser.launcherPath",
    ),
    expectedLauncherSha256: sha256(
      parserInput.expectedLauncherSha256,
      "pdfDocQa.parser.expectedLauncherSha256",
    ),
    packageRoot: absolutePath(
      parserInput.packageRoot,
      "pdfDocQa.parser.packageRoot",
    ),
    modelAssetsPath: absolutePath(
      parserInput.modelAssetsPath,
      "pdfDocQa.parser.modelAssetsPath",
    ),
    modelLockPath: absolutePath(
      parserInput.modelLockPath,
      "pdfDocQa.parser.modelLockPath",
    ),
    expectedModelLockSha256: sha256(
      parserInput.expectedModelLockSha256,
      "pdfDocQa.parser.expectedModelLockSha256",
    ),
  };
  const profileInput = object(input.profile, "pdfDocQa.profile");
  exact(profileInput, [
    "parserProfileId",
    "parserFingerprint",
    "extractionConfigurationFingerprint",
    "extractorFingerprint",
    "recordSchemaFingerprint",
    "normalizationFingerprint",
    "chunkerFingerprint",
    "correctionRevision",
  ]);
  if (profileInput.parserProfileId !== "pdf_docqa_v1") {
    fail("pdfDocQa.profile.parserProfileId is invalid");
  }
  const profile = {
    parserProfileId: "pdf_docqa_v1" as const,
    parserFingerprint: sha256(
      profileInput.parserFingerprint,
      "pdfDocQa.profile.parserFingerprint",
    ),
    extractionConfigurationFingerprint: sha256(
      profileInput.extractionConfigurationFingerprint,
      "pdfDocQa.profile.extractionConfigurationFingerprint",
    ),
    extractorFingerprint: profileText(
      profileInput.extractorFingerprint,
      "pdfDocQa.profile.extractorFingerprint",
    ),
    recordSchemaFingerprint: profileText(
      profileInput.recordSchemaFingerprint,
      "pdfDocQa.profile.recordSchemaFingerprint",
    ),
    normalizationFingerprint: profileText(
      profileInput.normalizationFingerprint,
      "pdfDocQa.profile.normalizationFingerprint",
    ),
    chunkerFingerprint: sha256(
      profileInput.chunkerFingerprint,
      "pdfDocQa.profile.chunkerFingerprint",
    ),
    correctionRevision: profileText(
      profileInput.correctionRevision,
      "pdfDocQa.profile.correctionRevision",
    ),
  };
  if (profile.chunkerFingerprint !== PDF_DOCQA_CHUNKING_FINGERPRINT) {
    fail(
      "pdfDocQa.profile.chunkerFingerprint is not the PDF document-Q&A policy",
    );
  }
  const archiveInput = object(input.archive, "pdfDocQa.archive");
  exact(archiveInput, ["ageBinary", "primary", "independentBackup"]);
  const primaryInput = object(archiveInput.primary, "pdfDocQa.archive.primary");
  exact(primaryInput, [
    "directory",
    "recipient",
    "archiveProfileFingerprint",
    "archiveIdentityFingerprint",
    "recipientFingerprint",
    "repositoryKeyDomainFingerprint",
    "storageFailureDomainFingerprint",
  ]);
  const primary = {
    directory: absolutePath(
      primaryInput.directory,
      "pdfDocQa.archive.primary.directory",
    ),
    recipient: recipient(
      primaryInput.recipient,
      "pdfDocQa.archive.primary.recipient",
    ),
    ...archiveIdentity(
      {
        archiveProfileFingerprint: primaryInput.archiveProfileFingerprint,
        archiveIdentityFingerprint: primaryInput.archiveIdentityFingerprint,
        recipientFingerprint: primaryInput.recipientFingerprint,
        repositoryKeyDomainFingerprint:
          primaryInput.repositoryKeyDomainFingerprint,
        storageFailureDomainFingerprint:
          primaryInput.storageFailureDomainFingerprint,
      },
      "pdfDocQa.archive.primary",
    ),
  };
  const backupInput = object(
    archiveInput.independentBackup,
    "pdfDocQa.archive.independentBackup",
  );
  exact(backupInput, [
    "directory",
    "recipient",
    "resticBinary",
    "repositoryPath",
    "expectedRepositoryId",
    "passwordCommand",
    "host",
    "archiveProfileFingerprint",
    "archiveIdentityFingerprint",
    "recipientFingerprint",
    "repositoryKeyDomainFingerprint",
    "storageFailureDomainFingerprint",
  ]);
  const independentBackup = {
    directory: absolutePath(
      backupInput.directory,
      "pdfDocQa.archive.independentBackup.directory",
    ),
    recipient: recipient(
      backupInput.recipient,
      "pdfDocQa.archive.independentBackup.recipient",
    ),
    resticBinary: absolutePath(
      backupInput.resticBinary,
      "pdfDocQa.archive.independentBackup.resticBinary",
    ),
    repositoryPath: absolutePath(
      backupInput.repositoryPath,
      "pdfDocQa.archive.independentBackup.repositoryPath",
    ),
    expectedRepositoryId: sha256(
      backupInput.expectedRepositoryId,
      "pdfDocQa.archive.independentBackup.expectedRepositoryId",
    ),
    passwordCommand: passwordCommand(backupInput.passwordCommand),
    host: profileText(
      backupInput.host,
      "pdfDocQa.archive.independentBackup.host",
    ),
    ...archiveIdentity(
      {
        archiveProfileFingerprint: backupInput.archiveProfileFingerprint,
        archiveIdentityFingerprint: backupInput.archiveIdentityFingerprint,
        recipientFingerprint: backupInput.recipientFingerprint,
        repositoryKeyDomainFingerprint:
          backupInput.repositoryKeyDomainFingerprint,
        storageFailureDomainFingerprint:
          backupInput.storageFailureDomainFingerprint,
      },
      "pdfDocQa.archive.independentBackup",
    ),
  };
  if (!HOST.test(independentBackup.host))
    fail("pdfDocQa archive host is invalid");
  if (primary.recipient === independentBackup.recipient) {
    fail("pdfDocQa archive recipients must differ");
  }
  const privatePaths = [
    captureDirectory,
    parserOutputRoot,
    spoolDirectory,
    primary.directory,
    independentBackup.directory,
    independentBackup.repositoryPath,
  ];
  for (let left = 0; left < privatePaths.length; left += 1) {
    for (let right = left + 1; right < privatePaths.length; right += 1) {
      const first = privatePaths[left]!;
      const second = privatePaths[right]!;
      if (overlaps(first, second)) {
        fail("pdfDocQa private paths must not overlap");
      }
    }
  }
  const parserReadRoots = [parser.packageRoot, parser.modelAssetsPath];
  for (const path of [...privatePaths, ...parserReadRoots]) {
    if (
      overlaps(path, journalDir) ||
      roots.some((root) => overlaps(path, root.path))
    ) {
      fail("pdfDocQa path overlaps a journal or scanned root");
    }
  }
  for (const readRoot of parserReadRoots) {
    if (privatePaths.some((privatePath) => overlaps(readRoot, privatePath))) {
      fail("pdfDocQa parser read roots must not overlap private output roots");
    }
  }
  const executablePaths = [
    parser.pythonExecutable,
    parser.launcherPath,
    parser.modelLockPath,
    absolutePath(archiveInput.ageBinary, "pdfDocQa.archive.ageBinary"),
    independentBackup.resticBinary,
    independentBackup.passwordCommand.executable,
  ];
  for (const path of executablePaths) {
    if (
      containsPath(journalDir, path) ||
      roots.some((root) => containsPath(root.path, path)) ||
      privatePaths.some((privatePath) => containsPath(privatePath, path))
    ) {
      fail("pdfDocQa executable paths must not be in writable roots");
    }
  }
  return {
    captureDirectory,
    parserOutputRoot,
    spoolDirectory,
    parser,
    profile,
    archive: {
      ageBinary: executablePaths[3]!,
      primary,
      independentBackup,
    },
  };
}

export function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("endpoint must be a URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/worker"
  )
    fail("endpoint must be an exact /api/worker URL");
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    fail("endpoint must use HTTPS except explicit loopback HTTP");
  return url.toString();
}

export function parseConfig(value: unknown): PipelineConfig {
  const source = object(value, "root");
  const allowed = new Set([
    "protocolVersion",
    "endpoint",
    "spaceId",
    "sourceAccountId",
    "credentialEnv",
    "roots",
    "journalDir",
    "hostAffinity",
    "watchIntervalMs",
    "maxFiles",
    "maxDepth",
    "maxFileBytes",
    "pdfDocQa",
  ]);
  for (const key of Object.keys(source))
    if (!allowed.has(key)) fail(`unknown field ${key}`);
  if (source.protocolVersion !== 1) fail("protocolVersion must be 1");
  const rootsValue = source.roots;
  if (
    !Array.isArray(rootsValue) ||
    rootsValue.length < 1 ||
    rootsValue.length > 16
  )
    fail("roots must contain 1 through 16 entries");
  const roots: RootConfig[] = rootsValue.map((entry, index) => {
    const root = object(entry, `roots[${index}]`);
    if (Object.keys(root).some((key) => key !== "alias" && key !== "path"))
      fail(`roots[${index}] has an unknown field`);
    const alias = string(root.alias, `roots[${index}].alias`);
    if (!ROOT_ALIAS.test(alias)) fail(`roots[${index}].alias is invalid`);
    const path = string(root.path, `roots[${index}].path`);
    if (!path.startsWith("/")) fail(`roots[${index}].path must be absolute`);
    return { alias, path: resolve(path) };
  });
  if (new Set(roots.map((root) => root.alias)).size !== roots.length)
    fail("root aliases must be unique");
  const journalValue = string(source.journalDir, "journalDir");
  if (!journalValue.startsWith("/")) fail("journalDir must be absolute");
  const journalDir = resolve(journalValue);
  const pdf =
    source.pdfDocQa === undefined
      ? undefined
      : pdfDocQa(source.pdfDocQa, roots, journalDir);
  return {
    protocolVersion: 1,
    endpoint: validateEndpoint(string(source.endpoint, "endpoint")),
    spaceId: (() => {
      const id = string(source.spaceId, "spaceId");
      if (!ID.test(id)) fail("spaceId is invalid");
      return id;
    })(),
    sourceAccountId: (() => {
      const id = string(source.sourceAccountId, "sourceAccountId");
      if (!ID.test(id)) fail("sourceAccountId is invalid");
      return id;
    })(),
    credentialEnv: (() => {
      const name = string(source.credentialEnv, "credentialEnv");
      if (!ENV.test(name)) fail("credentialEnv is invalid");
      return name;
    })(),
    roots,
    journalDir,
    ...(source.hostAffinity === undefined
      ? {}
      : {
          hostAffinity: (() => {
            const affinity = string(source.hostAffinity, "hostAffinity");
            if (Buffer.byteLength(affinity) > 128)
              fail("hostAffinity is too long");
            return affinity;
          })(),
        }),
    watchIntervalMs: integer(
      source.watchIntervalMs ?? 300_000,
      "watchIntervalMs",
      1_000,
      3_600_000,
    ),
    maxFiles: integer(source.maxFiles ?? 256, "maxFiles", 1, 256),
    maxDepth: integer(source.maxDepth ?? 16, "maxDepth", 1, 64),
    maxFileBytes: integer(
      source.maxFileBytes ?? 65_536,
      "maxFileBytes",
      1,
      65_536,
    ),
    ...(pdf === undefined ? {} : { pdfDocQa: pdf }),
  };
}

export async function loadPipelineConfig(
  path: string,
): Promise<PipelineConfig> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) fail("configuration must be a regular file");
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) fail("configuration is too large");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      fail("configuration must be UTF-8");
    }
    try {
      return parseConfig(JSON.parse(text));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Invalid pipeline config:")
      ) {
        throw error;
      }
      fail("configuration must be JSON");
    }
  } finally {
    await handle.close();
  }
}

export function requireCredential(config: PipelineConfig): string {
  const credential = process.env[config.credentialEnv];
  if (
    !credential ||
    credential.length > 8_192 ||
    /[\x00-\x1f\x7f\s]/.test(credential)
  )
    throw new Error("Worker credential is unavailable");
  return credential;
}

export function journalBindingForConfig(
  config: PipelineConfig,
): JournalBinding {
  const bindingInput =
    config.pdfDocQa === undefined
      ? {
          endpoint: config.endpoint,
          spaceId: config.spaceId,
          sourceAccountId: config.sourceAccountId,
          roots: config.roots,
        }
      : {
          endpoint: config.endpoint,
          spaceId: config.spaceId,
          sourceAccountId: config.sourceAccountId,
          roots: config.roots,
          pdfDocQa: config.pdfDocQa,
        };
  const configFingerprint = createHash("sha256")
    .update(JSON.stringify(bindingInput))
    .digest("hex");
  return {
    protocolVersion: 1,
    endpoint: config.endpoint,
    spaceId: config.spaceId,
    sourceAccountId: config.sourceAccountId,
    configFingerprint,
    credentialSlot: config.credentialEnv,
  };
}
