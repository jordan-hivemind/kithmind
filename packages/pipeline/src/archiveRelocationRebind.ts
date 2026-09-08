import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, link, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { openArchiveCatalog, type ArchiveCatalog } from "./archiveCatalog.js";
import type { ArchiveBoundaryRelocation } from "./archiveCatalogTypes.js";
import { validateArchiveRelocationConfig } from "./archiveRelocationConfig.js";
import { Journal, JournalSafetyError } from "./journal.js";
import type { JournalCodec, JsonValue } from "./journalTypes.js";
import { RCLONE_VERSION, RESTIC_VERSION } from "./archiveTypes.js";

const FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ArchiveRelocationRebindError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unsafe_store"
      | "intent_conflict"
      | "config_conflict"
      | "catalog_conflict"
      | "rebind_failed",
  ) {
    super(`Archive relocation rebind failed: ${code}`);
    this.name = "ArchiveRelocationRebindError";
  }
}

function fail(code: ArchiveRelocationRebindError["code"]): never {
  throw new ArchiveRelocationRebindError(code);
}

type FileIdentity = {
  device: number;
  inode: number;
  size: number;
  sha256: string;
  links: number;
};

type RebindIntent = {
  version: 1;
  relocationId: string;
  previousConfigJson: string;
  proposedConfigJson: string;
  configPath: string;
  intentPath: string;
  previousConfigSha256: string;
  proposedConfigSha256: string;
  relocation: ArchiveBoundaryRelocation;
  relocationFingerprint: string;
  catalogRevision: number;
  previousWatcherId: string;
  previousJournalStateSha256: string;
  proposedJournalStateSha256: string;
  preparedAt: number;
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsafe_store");
  return value;
}

function requireFile(stats: Stats, maximumLinks = 1): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink < 1 ||
    stats.nlink > maximumLinks ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== FILE_MODE
  )
    fail("unsafe_store");
}

async function requireProtectedAncestors(path: string): Promise<void> {
  let current = dirname(path);
  for (let count = 0; count < 256; count += 1) {
    const stats = await lstat(current).catch(() => fail("unsafe_store"));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.uid !== uid() && stats.uid !== 0) ||
      (stats.mode & 0o022) !== 0
    )
      fail("unsafe_store");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  fail("unsafe_store");
}

async function readProtected(
  inputPath: string,
  maximumBytes: number,
  maximumLinks = 1,
): Promise<{ path: string; text: string; identity: FileIdentity }> {
  const path = resolve(inputPath);
  await requireProtectedAncestors(path);
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_NONBLOCK !== "number"
  )
    fail("unsafe_store");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("unsafe_store"));
  try {
    if ((await realpath(path).catch(() => "")) !== path) fail("unsafe_store");
    const before = await handle.stat();
    requireFile(before, maximumLinks);
    if (before.size < 1 || before.size > maximumBytes) fail("unsafe_store");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    requireFile(after, maximumLinks);
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      fail("unsafe_store");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      fail("unsafe_store");
    }
    return {
      path,
      text,
      identity: {
        device: before.dev,
        inode: before.ino,
        size: before.size,
        sha256: hash(text),
        links: before.nlink,
      },
    };
  } finally {
    await handle.close();
  }
}

async function readProtectedOptional(
  inputPath: string,
  maximumBytes: number,
): Promise<Awaited<ReturnType<typeof readProtected>> | undefined> {
  const path = resolve(inputPath);
  const present = await lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("unsafe_store");
    });
  return present ? await readProtected(path, maximumBytes) : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  if (typeof constants.O_DIRECTORY !== "number") fail("unsafe_store");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY,
  ).catch(() => fail("unsafe_store"));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function intentTemp(path: string): string {
  return `${path}.prepared.tmp`;
}

async function readPublishedIntent(
  path: string,
  repairInterruptedPublication = true,
): Promise<Awaited<ReturnType<typeof readProtected>> | undefined> {
  const present = await lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("unsafe_store");
    });
  if (!present) return undefined;
  const published = await readProtected(path, MAX_INTENT_BYTES, 2);
  if (published.identity.links === 1) return published;
  const temporary = await readProtected(intentTemp(path), MAX_INTENT_BYTES, 2);
  if (
    temporary.identity.links !== 2 ||
    temporary.identity.device !== published.identity.device ||
    temporary.identity.inode !== published.identity.inode ||
    temporary.text !== published.text
  )
    fail("intent_conflict");
  if (!repairInterruptedPublication) return published;
  await unlink(intentTemp(path)).catch(() => fail("unsafe_store"));
  await syncDirectory(dirname(path));
  return await readProtected(path, MAX_INTENT_BYTES);
}

async function writeExclusive(path: string, text: string): Promise<void> {
  await requireProtectedAncestors(path);
  const temp = intentTemp(path);
  const prepared = await readProtectedOptional(temp, MAX_INTENT_BYTES);
  if (prepared === undefined) {
    const handle = await open(temp, "wx", FILE_MODE).catch(() =>
      fail("unsafe_store"),
    );
    try {
      requireFile(await handle.stat());
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else if (prepared.text !== text) {
    fail("intent_conflict");
  }
  let linked = false;
  try {
    await link(temp, path);
    linked = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail("intent_conflict");
    fail("unsafe_store");
  } finally {
    if (linked) await unlink(temp).catch(() => undefined);
  }
  if (linked) await syncDirectory(dirname(path));
}

async function replaceConfig(
  path: string,
  expected: FileIdentity,
  text: string,
  relocationId: string,
): Promise<void> {
  const current = await readProtected(path, MAX_CONFIG_BYTES);
  if (
    current.identity.device !== expected.device ||
    current.identity.inode !== expected.inode ||
    current.identity.size !== expected.size ||
    current.identity.sha256 !== expected.sha256
  )
    fail("config_conflict");
  const temp = `${path}.${relocationId}.rebind.tmp`;
  let renamed = false;
  try {
    const prepared = await readProtectedOptional(temp, MAX_CONFIG_BYTES);
    if (prepared === undefined) {
      const handle = await open(temp, "wx", FILE_MODE);
      try {
        requireFile(await handle.stat());
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else if (prepared.text !== text) {
      fail("config_conflict");
    }
    const beforeRename = await readProtected(path, MAX_CONFIG_BYTES);
    if (
      beforeRename.identity.device !== expected.device ||
      beforeRename.identity.inode !== expected.inode ||
      beforeRename.identity.size !== expected.size ||
      beforeRename.identity.sha256 !== expected.sha256
    )
      fail("config_conflict");
    await rename(temp, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error instanceof ArchiveRelocationRebindError) throw error;
    fail("unsafe_store");
  }
  if ((await readProtected(path, MAX_CONFIG_BYTES)).text !== text)
    fail("config_conflict");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("invalid_input");
  }
}

/** Verify the exact protected configuration bytes before any relocation side effect. */
export async function requireArchiveRelocationPreviousConfigFiles(args: {
  configPath: string;
  proposedConfigPath: string;
  previousConfigText: string;
  proposedConfigText: string;
}): Promise<void> {
  const previous = await readProtected(
    resolve(args.configPath),
    MAX_CONFIG_BYTES,
  );
  const proposed = await readProtected(
    resolve(args.proposedConfigPath),
    MAX_CONFIG_BYTES,
  );
  if (
    previous.text !== args.previousConfigText ||
    proposed.text !== args.proposedConfigText
  )
    fail("config_conflict");
}

function canonicalRelocation(value: ArchiveBoundaryRelocation): string {
  return JSON.stringify(value);
}

function intentJson(intent: RebindIntent): string {
  const text = `${JSON.stringify(intent)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_INTENT_BYTES) fail("invalid_input");
  return text;
}

function parseIntent(value: unknown): RebindIntent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("intent_conflict");
  const row = value as Record<string, unknown>;
  const fields = [
    "version",
    "relocationId",
    "previousConfigJson",
    "proposedConfigJson",
    "configPath",
    "intentPath",
    "previousConfigSha256",
    "proposedConfigSha256",
    "relocation",
    "relocationFingerprint",
    "catalogRevision",
    "previousWatcherId",
    "previousJournalStateSha256",
    "proposedJournalStateSha256",
    "preparedAt",
  ];
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(row, field)) ||
    row.version !== 1 ||
    typeof row.relocationId !== "string" ||
    !UUID.test(row.relocationId) ||
    typeof row.previousConfigJson !== "string" ||
    typeof row.proposedConfigJson !== "string" ||
    typeof row.configPath !== "string" ||
    resolve(row.configPath) !== row.configPath ||
    typeof row.intentPath !== "string" ||
    resolve(row.intentPath) !== row.intentPath ||
    typeof row.previousConfigSha256 !== "string" ||
    typeof row.proposedConfigSha256 !== "string" ||
    typeof row.relocationFingerprint !== "string" ||
    !SHA256.test(row.previousConfigSha256) ||
    !SHA256.test(row.proposedConfigSha256) ||
    !SHA256.test(row.relocationFingerprint) ||
    typeof row.previousWatcherId !== "string" ||
    !UUID.test(row.previousWatcherId) ||
    typeof row.previousJournalStateSha256 !== "string" ||
    !SHA256.test(row.previousJournalStateSha256) ||
    typeof row.proposedJournalStateSha256 !== "string" ||
    !SHA256.test(row.proposedJournalStateSha256) ||
    !Number.isSafeInteger(row.catalogRevision) ||
    (row.catalogRevision as number) < 1 ||
    !Number.isSafeInteger(row.preparedAt) ||
    (row.preparedAt as number) < 0
  )
    fail("intent_conflict");
  const relocation = row.relocation as ArchiveBoundaryRelocation;
  if (
    relocation?.relocationId !== row.relocationId ||
    hash(row.previousConfigJson) !== row.previousConfigSha256 ||
    hash(row.proposedConfigJson) !== row.proposedConfigSha256 ||
    hash(canonicalRelocation(relocation)) !== row.relocationFingerprint
  )
    fail("intent_conflict");
  validateArchiveRelocationConfig(
    parseJson(row.previousConfigJson),
    parseJson(row.proposedConfigJson),
  );
  return row as RebindIntent;
}

function requireConfigMatchesRelocation(
  previousConfig: unknown,
  proposedConfig: unknown,
  relocation: ArchiveBoundaryRelocation,
): void {
  const validated = validateArchiveRelocationConfig(
    previousConfig,
    proposedConfig,
  );
  const previous = previousConfig as {
    pdfDocQa?: {
      archive?: {
        independentBackup?: {
          expectedRepositoryId?: unknown;
          repository?: Record<string, unknown>;
        };
      };
    };
  };
  const proposed = proposedConfig as typeof previous;
  const boundary = (value: typeof previous) => {
    const backup = value.pdfDocQa?.archive?.independentBackup;
    const repository = backup?.repository;
    if (!backup || !repository) fail("invalid_input");
    return {
      mode: "independent_backup",
      readiness: "remote_repository_verified",
      backend: "rclone_dropbox_v1",
      remoteName: repository.remoteName,
      rootPath: repository.rootPath,
      rootDirectoryIdHash: repository.expectedRootDirectoryIdHash,
      configIdentityFingerprint: repository.configIdentityFingerprint,
      repositoryId: backup.expectedRepositoryId,
      resticVersion: RESTIC_VERSION,
      rcloneVersion: RCLONE_VERSION,
    };
  };
  if (
    JSON.stringify(boundary(previous)) !==
      JSON.stringify(relocation.oldBoundary) ||
    JSON.stringify(boundary(proposed)) !==
      JSON.stringify(relocation.newBoundary) ||
    validated.previousBinding.configFingerprint ===
      validated.proposedBinding.configFingerprint
  )
    fail("catalog_conflict");
}

async function requireCatalogIntent(
  catalog: ArchiveCatalog,
  intent: RebindIntent,
): Promise<void> {
  const current = await catalog.requireBoundaryRelocation(intent.relocationId);
  if (
    current.catalogRevision !== intent.catalogRevision ||
    canonicalRelocation(current.relocation) !==
      canonicalRelocation(intent.relocation)
  )
    fail("catalog_conflict");
}

export async function prepareArchiveRelocationRebind<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  journal: Journal<C, R>;
  configPath: string;
  proposedConfigPath: string;
  intentPath: string;
  relocationId: string;
  now?: () => number;
}): Promise<void> {
  const current = await readProtected(args.configPath, MAX_CONFIG_BYTES);
  const proposed = await readProtected(
    args.proposedConfigPath,
    MAX_CONFIG_BYTES,
  );
  const validated = validateArchiveRelocationConfig(
    parseJson(current.text),
    parseJson(proposed.text),
  );
  if (
    JSON.stringify(args.journal.binding) !==
      JSON.stringify(validated.previousBinding) ||
    args.journal.credentialStatus !== "current" ||
    args.journal.pending !== undefined ||
    !(
      args.journal.checkpoint !== null &&
      !Array.isArray(args.journal.checkpoint) &&
      typeof args.journal.checkpoint === "object" &&
      args.journal.checkpoint.phase === "idle"
    )
  )
    fail("rebind_failed");
  const catalog = await openArchiveCatalog({ journal: args.journal });
  const catalogEvidence = await catalog.requireBoundaryRelocation(
    args.relocationId,
  );
  requireConfigMatchesRelocation(
    parseJson(current.text),
    parseJson(proposed.text),
    catalogEvidence.relocation,
  );
  const journalStatus = await args.journal.archiveRelocationRebindStatus({
    previousConfig: parseJson(current.text),
    proposedConfig: parseJson(proposed.text),
  });
  if (journalStatus.state !== "previous") fail("rebind_failed");
  const intentPath = resolve(args.intentPath);
  if (dirname(intentPath) !== args.journal.directory) fail("invalid_input");
  const intent: RebindIntent = {
    version: 1,
    relocationId: catalogEvidence.relocation.relocationId,
    previousConfigJson: current.text,
    proposedConfigJson: proposed.text,
    configPath: current.path,
    intentPath,
    previousConfigSha256: current.identity.sha256,
    proposedConfigSha256: proposed.identity.sha256,
    relocation: catalogEvidence.relocation,
    relocationFingerprint: hash(
      canonicalRelocation(catalogEvidence.relocation),
    ),
    catalogRevision: catalogEvidence.catalogRevision,
    previousWatcherId: args.journal.watcherId,
    previousJournalStateSha256: journalStatus.previousStateSha256,
    proposedJournalStateSha256: journalStatus.proposedStateSha256,
    preparedAt: (args.now ?? Date.now)(),
  };
  if (!Number.isSafeInteger(intent.preparedAt) || intent.preparedAt < 0)
    fail("invalid_input");
  const existing = await readPublishedIntent(intentPath);
  if (existing !== undefined) {
    const saved = parseIntent(parseJson(existing.text));
    const candidate = { ...intent, preparedAt: saved.preparedAt };
    if (intentJson(saved) !== intentJson(candidate)) fail("intent_conflict");
    return;
  }
  try {
    await writeExclusive(intentPath, intentJson(intent));
  } catch (error) {
    if (
      error instanceof ArchiveRelocationRebindError &&
      error.code === "intent_conflict"
    ) {
      const existing = parseIntent(
        parseJson((await readProtected(intentPath, MAX_INTENT_BYTES)).text),
      );
      if (intentJson(existing) === intentJson(intent)) return;
    }
    throw error;
  }
}

export type ArchiveRelocationRebindResult<
  C extends JsonValue,
  R extends JsonValue,
> = {
  journal: Journal<C, R>;
  state: "rebound";
  relocationId: string;
  previousWatcherId: string;
  currentWatcherId: string;
  watcherIdentityChanged: true;
};

export async function resumeArchiveRelocationRebind<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  journal: Journal<C, R>;
  configPath: string;
  intentPath: string;
  /** A bounded failure-injection checkpoint used by deterministic tests. */
  afterJournalTransfer?: () => Promise<void>;
}): Promise<ArchiveRelocationRebindResult<C, R>> {
  const intent = parseIntent(
    parseJson((await readPublishedIntent(args.intentPath))?.text ?? ""),
  );
  if (
    resolve(args.configPath) !== intent.configPath ||
    resolve(args.intentPath) !== intent.intentPath
  )
    fail("intent_conflict");
  const catalog = await openArchiveCatalog({ journal: args.journal });
  await requireCatalogIntent(catalog, intent);
  const previousConfig = parseJson(intent.previousConfigJson);
  const proposedConfig = parseJson(intent.proposedConfigJson);
  requireConfigMatchesRelocation(
    previousConfig,
    proposedConfig,
    intent.relocation,
  );
  const journalStatus = await args.journal.archiveRelocationRebindStatus({
    previousConfig,
    proposedConfig,
  });
  if (
    journalStatus.previousStateSha256 !== intent.previousJournalStateSha256 ||
    journalStatus.proposedStateSha256 !== intent.proposedJournalStateSha256 ||
    journalStatus.stateSha256 !==
      (journalStatus.state === "previous"
        ? intent.previousJournalStateSha256
        : intent.proposedJournalStateSha256)
  )
    fail("rebind_failed");
  const current = await readProtected(args.configPath, MAX_CONFIG_BYTES);
  if (
    current.identity.sha256 !== intent.previousConfigSha256 &&
    current.identity.sha256 !== intent.proposedConfigSha256
  )
    fail("config_conflict");
  if (current.identity.sha256 === intent.previousConfigSha256) {
    await replaceConfig(
      current.path,
      current.identity,
      intent.proposedConfigJson,
      intent.relocationId,
    );
  }
  let journal: Journal<C, R>;
  try {
    journal = await args.journal.rebindForArchiveRelocation({
      previousConfig,
      proposedConfig,
    });
  } catch (error) {
    if (error instanceof JournalSafetyError) fail("rebind_failed");
    throw error;
  }
  try {
    await args.afterJournalTransfer?.();
    const finalConfig = await readProtected(args.configPath, MAX_CONFIG_BYTES);
    if (finalConfig.identity.sha256 !== intent.proposedConfigSha256)
      fail("config_conflict");
    if (journal.watcherId === intent.previousWatcherId) fail("rebind_failed");
  } catch (error) {
    await journal.close();
    throw error;
  }
  return {
    journal,
    state: "rebound",
    relocationId: intent.relocationId,
    previousWatcherId: intent.previousWatcherId,
    currentWatcherId: journal.watcherId,
    watcherIdentityChanged: true,
  };
}

export async function recoverArchiveRelocationRebind<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  configPath: string;
  intentPath: string;
  credential: string;
  codec: JournalCodec<C, R>;
}): Promise<Omit<ArchiveRelocationRebindResult<C, R>, "journal">> {
  const intent = parseIntent(
    parseJson((await readPublishedIntent(args.intentPath, false))?.text ?? ""),
  );
  if (
    resolve(args.configPath) !== intent.configPath ||
    resolve(args.intentPath) !== intent.intentPath
  )
    fail("intent_conflict");
  const previousConfig = parseJson(intent.previousConfigJson);
  const proposedConfig = parseJson(intent.proposedConfigJson);
  const validated = validateArchiveRelocationConfig(
    previousConfig,
    proposedConfig,
  );
  const previous = previousConfig as { journalDir?: unknown };
  const proposed = proposedConfig as { journalDir?: unknown };
  if (
    typeof previous.journalDir !== "string" ||
    previous.journalDir !== proposed.journalDir
  )
    fail("intent_conflict");
  let journal = await Journal.openExistingForArchiveRebind({
    directory: previous.journalDir,
    previousConfig,
    proposedConfig,
    credential: args.credential,
    codec: args.codec,
  });
  try {
    if (
      JSON.stringify(journal.binding) !==
        JSON.stringify(validated.previousBinding) &&
      JSON.stringify(journal.binding) !==
        JSON.stringify(validated.proposedBinding)
    )
      fail("rebind_failed");
    const result = await resumeArchiveRelocationRebind({
      journal,
      configPath: args.configPath,
      intentPath: args.intentPath,
    });
    journal = result.journal;
    return {
      state: result.state,
      relocationId: result.relocationId,
      previousWatcherId: result.previousWatcherId,
      currentWatcherId: result.currentWatcherId,
      watcherIdentityChanged: true,
    };
  } finally {
    await journal.close();
  }
}
