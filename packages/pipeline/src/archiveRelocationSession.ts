import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";

import { openArchiveCatalog, type ArchiveCatalog } from "./archiveCatalog.js";
import {
  prepareArchiveRelocationRebind,
  resumeArchiveRelocationRebind,
} from "./archiveRelocationRebind.js";
import { validateArchiveRelocationConfig } from "./archiveRelocationConfig.js";
import type {
  ArchiveRelocationEvidence,
  ArchiveRelocationState,
  ArchiveRelocationStore,
} from "./archiveRelocationWorkflow.js";
import { validateArchiveRelocationState } from "./archiveRelocationWorkflow.js";
import { Journal } from "./journal.js";
import type { JournalCodec, JsonValue } from "./journalTypes.js";

const FILE_MODE = 0o600;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const PHASES = new Set([
  "prepared",
  "source_verified",
  "move_requested",
  "moved",
  "verified",
  "rebound",
  "resumed",
]);

export class ArchiveRelocationSessionError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unsafe_store" | "store_conflict" | "session_closed",
  ) {
    super(`Archive relocation session failed: ${code}`);
    this.name = "ArchiveRelocationSessionError";
  }
}

function fail(code: ArchiveRelocationSessionError["code"]): never {
  throw new ArchiveRelocationSessionError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid_input");
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  if (
    keys.some((key) => !(key in row)) ||
    Object.keys(row).some(
      (key) =>
        !keys.includes(key) ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype",
    )
  )
    fail("invalid_input");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function repositoryPathUnder(
  providerRootPath: string,
  repositoryRelativePath: string,
): string {
  if (
    !providerRootPath.startsWith("/") ||
    providerRootPath === "/" ||
    providerRootPath !== posix.normalize(providerRootPath)
  )
    fail("invalid_input");
  return posix.join(providerRootPath.slice(1), repositoryRelativePath);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsafe_store");
  return value;
}

function requireFile(stats: Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
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

type ProtectedFile = {
  text: string;
  device: number;
  inode: number;
  size: number;
  hash: string;
};

async function readFile(path: string): Promise<ProtectedFile> {
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
    requireFile(before);
    if (before.size < 1 || before.size > MAX_STORE_BYTES) fail("unsafe_store");
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
    requireFile(after);
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
      text,
      device: before.dev,
      inode: before.ino,
      size: before.size,
      hash: sha256(text),
    };
  } finally {
    await handle.close();
  }
}

async function optionalFile(path: string): Promise<ProtectedFile | undefined> {
  const present = await lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("unsafe_store");
    });
  return present ? await readFile(path) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail("unsafe_store");
    });
}

async function syncDirectory(path: string): Promise<void> {
  if (typeof constants.O_DIRECTORY !== "number") fail("unsafe_store");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type StoreEnvelope = {
  version: 1;
  relocationId: string;
  revision: number;
  previousFileSha256: string | null;
  state: ArchiveRelocationState;
};

function parseEnvelope(text: string, relocationId: string): StoreEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("invalid_input");
  }
  const row = record(value);
  exact(row, [
    "version",
    "relocationId",
    "revision",
    "previousFileSha256",
    "state",
  ]);
  let state: ArchiveRelocationState | undefined;
  try {
    state = validateArchiveRelocationState(row.state);
  } catch {
    fail("invalid_input");
  }
  if (
    row.version !== 1 ||
    row.relocationId !== relocationId ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    (row.previousFileSha256 !== null &&
      (typeof row.previousFileSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.previousFileSha256))) ||
    state === undefined ||
    !PHASES.has(state.phase) ||
    state.intent.relocationId !== relocationId
  )
    fail("invalid_input");
  return { ...(row as unknown as StoreEnvelope), state };
}

function encodeEnvelope(envelope: StoreEnvelope): string {
  const text = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) fail("invalid_input");
  return text;
}

function sameFile(left: ProtectedFile, right: ProtectedFile): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.hash === right.hash
  );
}

export class ProtectedArchiveRelocationStore implements ArchiveRelocationStore {
  private observed: ProtectedFile | undefined;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly relocationId: string,
    private journal: Journal<JsonValue, JsonValue>,
    private readonly directoryIdentity: { device: number; inode: number },
  ) {}

  static async open<C extends JsonValue, R extends JsonValue>(args: {
    path: string;
    relocationId: string;
    journal: Journal<C, R>;
  }): Promise<ProtectedArchiveRelocationStore> {
    const path = resolve(args.path);
    if (
      dirname(path) !== args.journal.directory ||
      basename(path) !== `archive-relocation-${args.relocationId}.json`
    )
      fail("invalid_input");
    await requireProtectedAncestors(path);
    const directory = await lstat(args.journal.directory).catch(() =>
      fail("unsafe_store"),
    );
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== uid() ||
      (directory.mode & 0o777) !== 0o700 ||
      (await realpath(args.journal.directory).catch(() => "")) !==
        args.journal.directory
    )
      fail("unsafe_store");
    const store = new ProtectedArchiveRelocationStore(
      path,
      args.relocationId,
      args.journal as unknown as Journal<JsonValue, JsonValue>,
      { device: directory.dev, inode: directory.ino },
    );
    await store.recoverTemp();
    return store;
  }

  replaceJournal<C extends JsonValue, R extends JsonValue>(
    journal: Journal<C, R>,
  ): void {
    if (this.closed || journal.directory !== dirname(this.path))
      fail("session_closed");
    // The guarded accessor proves the replacement is live while this session
    // still owns it. `binding` itself is a readonly data property.
    void journal.checkpoint;
    this.journal = journal as unknown as Journal<JsonValue, JsonValue>;
  }

  close(): void {
    this.closed = true;
  }

  async read(): Promise<unknown> {
    this.assertOpen();
    await this.assertDirectory();
    await this.recoverTemp();
    const current = await optionalFile(this.path);
    this.observed = current;
    if (current === undefined) return undefined;
    return structuredClone(
      parseEnvelope(current.text, this.relocationId).state,
    );
  }

  async write(state: ArchiveRelocationState): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    const current = await optionalFile(this.path);
    if (
      (this.observed === undefined) !== (current === undefined) ||
      (this.observed !== undefined &&
        current !== undefined &&
        !sameFile(this.observed, current))
    )
      fail("store_conflict");
    const prior =
      current === undefined
        ? undefined
        : parseEnvelope(current.text, this.relocationId);
    const envelope: StoreEnvelope = {
      version: 1,
      relocationId: this.relocationId,
      revision: (prior?.revision ?? 0) + 1,
      previousFileSha256: current?.hash ?? null,
      state: structuredClone(state),
    };
    // The workflow is the full state validator. The store independently pins
    // its identity and phase so it cannot persist another relocation's bytes.
    const encoded = encodeEnvelope(envelope);
    parseEnvelope(encoded, this.relocationId);
    const temp = this.tempPath();
    if ((await optionalFile(temp)) !== undefined) fail("store_conflict");
    const handle = await open(temp, "wx", FILE_MODE).catch(() =>
      fail("unsafe_store"),
    );
    let created: Stats;
    try {
      created = await handle.stat();
      requireFile(created);
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const prepared = await readFile(temp);
    if (
      prepared.device !== created.dev ||
      prepared.inode !== created.ino ||
      prepared.text !== encoded ||
      prepared.hash !== sha256(encoded)
    )
      fail("store_conflict");
    const beforeRename = await optionalFile(this.path);
    const beforeRenameTemp = await optionalFile(temp);
    if (
      (current === undefined) !== (beforeRename === undefined) ||
      (current !== undefined &&
        beforeRename !== undefined &&
        !sameFile(current, beforeRename)) ||
      beforeRenameTemp === undefined ||
      !sameFile(prepared, beforeRenameTemp)
    )
      fail("store_conflict");
    await rename(temp, this.path).catch(() => fail("unsafe_store"));
    await syncDirectory(dirname(this.path));
    this.observed = await readFile(this.path);
    if (this.observed.hash !== prepared.hash) fail("store_conflict");
  }

  private tempPath(): string {
    return `${this.path}.${this.relocationId}.tmp`;
  }

  private assertOpen(): void {
    if (this.closed) fail("session_closed");
    // A closed or poisoned journal must make the store unusable too.
    void this.journal.checkpoint;
  }

  private async recoverTemp(): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    const temp = await optionalFile(this.tempPath());
    if (temp === undefined) return;
    const candidate = parseEnvelope(temp.text, this.relocationId);
    const current = await optionalFile(this.path);
    if (current === undefined) {
      if (candidate.previousFileSha256 !== null || candidate.revision !== 1)
        fail("store_conflict");
    } else {
      const saved = parseEnvelope(current.text, this.relocationId);
      if (
        candidate.previousFileSha256 !== current.hash ||
        candidate.revision !== saved.revision + 1
      )
        fail("store_conflict");
    }
    const confirm = await optionalFile(this.path);
    const confirmTemp = await optionalFile(this.tempPath());
    if (
      (current === undefined) !== (confirm === undefined) ||
      (current !== undefined &&
        confirm !== undefined &&
        !sameFile(current, confirm)) ||
      confirmTemp === undefined ||
      !sameFile(temp, confirmTemp)
    )
      fail("store_conflict");
    await rename(this.tempPath(), this.path).catch(() => fail("unsafe_store"));
    await syncDirectory(dirname(this.path));
    if ((await readFile(this.path)).hash !== temp.hash) fail("store_conflict");
  }

  private async assertDirectory(): Promise<void> {
    await requireProtectedAncestors(this.path);
    const stats = await lstat(dirname(this.path)).catch(() =>
      fail("unsafe_store"),
    );
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== uid() ||
      (stats.mode & 0o777) !== 0o700 ||
      stats.dev !== this.directoryIdentity.device ||
      stats.ino !== this.directoryIdentity.inode ||
      (await realpath(dirname(this.path)).catch(() => "")) !==
        dirname(this.path)
    )
      fail("unsafe_store");
  }
}

export class ArchiveRelocationSession<
  C extends JsonValue,
  R extends JsonValue,
> {
  private closed = false;

  private constructor(
    private currentJournal: Journal<C, R>,
    private currentCatalog: ArchiveCatalog,
    readonly store: ProtectedArchiveRelocationStore,
    private readonly args: {
      configPath: string;
      proposedConfigPath: string;
      intentPath: string;
      workflowRelocationId: string;
      catalogRelocationId: string;
      repositoryRelativePath: string;
    },
  ) {}

  static async open<C extends JsonValue, R extends JsonValue>(args: {
    previousConfig: unknown;
    proposedConfig: unknown;
    configPath: string;
    proposedConfigPath: string;
    intentPath: string;
    statePath: string;
    workflowRelocationId: string;
    catalogRelocationId: string;
    repositoryRelativePath: string;
    credential: string;
    codec: JournalCodec<C, R>;
  }): Promise<ArchiveRelocationSession<C, R>> {
    validateArchiveRelocationConfig(args.previousConfig, args.proposedConfig);
    const previous = record(args.previousConfig);
    const proposed = record(args.proposedConfig);
    if (
      typeof previous.journalDir !== "string" ||
      previous.journalDir !== proposed.journalDir ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(
        args.repositoryRelativePath,
      )
    )
      fail("invalid_input");
    const journalDirectory = resolve(previous.journalDir);
    if (
      resolve(args.intentPath) !==
        resolve(journalDirectory, "archive-rebind-intent.json") ||
      resolve(args.statePath) !==
        resolve(
          journalDirectory,
          `archive-relocation-${args.workflowRelocationId}.json`,
        )
    )
      fail("invalid_input");
    const journal = await Journal.openExistingForArchiveRebind({
      directory: previous.journalDir,
      previousConfig: args.previousConfig,
      proposedConfig: args.proposedConfig,
      credential: args.credential,
      codec: args.codec,
    });
    try {
      const catalog = await openArchiveCatalog({ journal });
      const store = await ProtectedArchiveRelocationStore.open({
        path: args.statePath,
        relocationId: args.workflowRelocationId,
        journal,
      });
      return new ArchiveRelocationSession(journal, catalog, store, {
        configPath: resolve(args.configPath),
        proposedConfigPath: resolve(args.proposedConfigPath),
        intentPath: resolve(args.intentPath),
        workflowRelocationId: args.workflowRelocationId,
        catalogRelocationId: args.catalogRelocationId,
        repositoryRelativePath: args.repositoryRelativePath,
      });
    } catch (error) {
      await journal.close();
      throw error;
    }
  }

  get journal(): Journal<C, R> {
    this.assertOpen();
    return this.currentJournal;
  }

  get catalog(): ArchiveCatalog {
    this.assertOpen();
    return this.currentCatalog;
  }

  async rebindRootPath(evidence: ArchiveRelocationEvidence): Promise<void> {
    this.assertOpen();
    if (evidence.relocationId !== this.args.workflowRelocationId)
      fail("invalid_input");
    const persisted = await this.currentCatalog.requireBoundaryRelocation(
      this.args.catalogRelocationId,
    );
    if (
      persisted.relocation.oldBoundary.rootPath !==
        repositoryPathUnder(
          evidence.oldBoundary.rootPath,
          this.args.repositoryRelativePath,
        ) ||
      persisted.relocation.newBoundary.rootPath !==
        repositoryPathUnder(
          evidence.newBoundary.rootPath,
          this.args.repositoryRelativePath,
        )
    )
      fail("invalid_input");
    const intentExists = await pathExists(this.args.intentPath);
    if (!intentExists) {
      await prepareArchiveRelocationRebind({
        journal: this.currentJournal,
        configPath: this.args.configPath,
        proposedConfigPath: this.args.proposedConfigPath,
        intentPath: this.args.intentPath,
        relocationId: this.args.catalogRelocationId,
      });
    }
    const result = await resumeArchiveRelocationRebind({
      journal: this.currentJournal,
      configPath: this.args.configPath,
      intentPath: this.args.intentPath,
    });
    this.currentJournal = result.journal;
    try {
      this.currentCatalog = await openArchiveCatalog({
        journal: this.currentJournal,
      });
      this.store.replaceJournal(this.currentJournal);
    } catch (error) {
      this.closed = true;
      this.store.close();
      await this.currentJournal.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
    await this.currentJournal.close();
  }

  private assertOpen(): void {
    if (this.closed) fail("session_closed");
    void this.currentJournal.checkpoint;
  }
}
