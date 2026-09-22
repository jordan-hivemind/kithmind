import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";

import {
  JOURNAL_OPERATIONS,
  type CheckpointTransition,
  type JournalBinding,
  type JournalCodec,
  type JournalCredentialStatus,
  type JournalInspection,
  type JournalOperation,
  type JsonValue,
  type PendingRequest,
  type PlanRequest,
} from "./journalTypes.js";
import { validateArchiveRelocationConfig } from "./archiveRelocationConfig.js";

const STATE_FILE = "state.json";
const FAILURE_FILE = "failure.json";
const MAX_FAILURE_RECORD_BYTES = 4 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_REQUEST_BODY_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
/**
 * ADM-4c. Sized for the largest checkpoint the runner can now hold: 1024
 * binary plans, each carrying seven 64-hex fingerprints, beside up to 4096
 * identity bindings. `journal.test.mjs` measures both. The three bounds below
 * were 768 KiB, 2 MiB and 20,000, which fit 256 plans and nothing more. They
 * are structural guards on a local file, not a protocol contract, so raising
 * them costs a larger atomic write and nothing else.
 */
const MAX_CHECKPOINT_BYTES = 3 * 1024 * 1024;
const MAX_STATE_BYTES = 6 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 60_000;
const LOCK_PORT_BASE = 16_384;
const LOCK_PORT_COUNT = 16_384;
const HEX_64 = /^[a-f0-9]{64}$/;
const SALT = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const CREDENTIAL_SLOT = /^[A-Z_][A-Z0-9_]{0,127}$/;
const TEMP_FILE = /^\.state\.json\.[0-9a-f-]{36}\.tmp$/;

type StoredResult = { value: JsonValue; digest: string; receivedAt: number };
type StoredPending = {
  operation: JournalOperation;
  requestId: string;
  requestBody: string;
  requestDigest: string;
  createdAt: number;
  result?: StoredResult;
};
type StoredState = {
  version: 1;
  binding: JournalBinding;
  credentialSalt: string;
  credentialFingerprint: string;
  credentialSessionActive: boolean;
  checkpoint: JsonValue;
  pending?: StoredPending;
};

export class JournalSafetyError extends Error {
  constructor(message: string) {
    super(`Pipeline journal is unsafe: ${message}`);
    this.name = "JournalSafetyError";
  }
}
export class JournalLockedError extends Error {
  constructor() {
    super("Pipeline source is already locked");
    this.name = "JournalLockedError";
  }
}
export class JournalCredentialChangedError extends Error {
  constructor() {
    super("Pipeline credential recovery is required");
    this.name = "JournalCredentialChangedError";
  }
}

function fail(message: string): never {
  throw new JournalSafetyError(message);
}
function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("journal field is not an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    required.some((key) => !own(record, key))
  )
    fail("journal object fields are invalid");
  return record;
}
function boundedString(
  value: unknown,
  maximumBytes: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== undefined && !pattern.test(value))
  )
    fail("journal string is invalid");
  return value;
}
function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("journal integer is invalid");
  return value as number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("journal boolean is invalid");
  return value;
}

function normalizeJson(value: unknown, maximumBytes: number): JsonValue {
  let nodes = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
      fail("journal JSON exceeds structural bounds");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("journal JSON number is invalid");
      return current;
    }
    if (Array.isArray(current))
      return current.map((entry) => visit(entry, depth + 1));
    if (!current || typeof current !== "object")
      fail("journal JSON value is invalid");
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null)
      fail("journal JSON value is invalid");
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        Buffer.byteLength(key, "utf8") > 256
      )
        fail("journal JSON key is invalid");
      result[key] = visit(entry, depth + 1);
    }
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > maximumBytes)
    fail("journal JSON exceeds byte limit");
  return normalized;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function parseOperation(value: unknown): JournalOperation {
  if (
    typeof value !== "string" ||
    !(JOURNAL_OPERATIONS as readonly string[]).includes(value)
  )
    fail("journal operation is invalid");
  return value as JournalOperation;
}
function parseBinding(value: unknown): JournalBinding {
  const record = exactObject(value, [
    "protocolVersion",
    "endpoint",
    "spaceId",
    "sourceAccountId",
    "configFingerprint",
    "credentialSlot",
  ]);
  if (record.protocolVersion !== 1) fail("journal protocol version is invalid");
  const endpoint = boundedString(record.endpoint, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail("journal endpoint is invalid");
  }
  if (
    parsed.toString() !== endpoint ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/api/worker"
  )
    fail("journal endpoint is not canonical");
  return Object.freeze({
    protocolVersion: 1,
    endpoint,
    spaceId: boundedString(record.spaceId, 256, ID),
    sourceAccountId: boundedString(record.sourceAccountId, 256, ID),
    configFingerprint: boundedString(record.configFingerprint, 64, HEX_64),
    credentialSlot: boundedString(record.credentialSlot, 128, CREDENTIAL_SLOT),
  });
}
function bindingEqual(left: JournalBinding, right: JournalBinding): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.endpoint === right.endpoint &&
    left.spaceId === right.spaceId &&
    left.sourceAccountId === right.sourceAccountId &&
    left.configFingerprint === right.configFingerprint &&
    left.credentialSlot === right.credentialSlot
  );
}

/**
 * ADM-10. The binding without its configuration fingerprint: what names *this
 * installation of this watcher for this source account*, and nothing about how
 * it happens to be configured today.
 *
 * Written as a literal rather than by deleting a key, because the key order is
 * part of the hash input in `mintWatcherId` and a spread would carry whatever
 * order `parseBinding` happened to freeze.
 */
function authorityOf(binding: JournalBinding): Record<string, unknown> {
  return {
    protocolVersion: binding.protocolVersion,
    endpoint: binding.endpoint,
    spaceId: binding.spaceId,
    sourceAccountId: binding.sourceAccountId,
    credentialSlot: binding.credentialSlot,
  };
}

/**
 * A canonical lowercase v5-shaped UUID over a salt and a payload.
 *
 * ADM-10. Two versions exist and both are computed on every open:
 *
 * `v2` (`watcherId`, what the heartbeat presents) hashes the salt and
 * `authorityOf(binding)`. `v1` (`legacyWatcherId`) hashes the salt and the
 * whole binding, including `configFingerprint`.
 *
 * `configFingerprint` hashes the endpoint, space, account, the watched roots
 * with their absolute paths and the whole `pdfDocQa` block
 * (`journalBindingForConfig`, config.ts). Under `v1` every ordinary
 * configuration change -- adding a root, moving the parser, upgrading it --
 * minted a new watcher identity, and `recordWorkerHeartbeat` refuses an
 * identity it did not register, before any write, forever. The watcher went on
 * completing passes while the server recorded it as missing; PR #316 made it
 * say so once per process, and this is the derivation that stops it happening.
 *
 * What stays: the salt (`credentialSalt`, 32 random bytes minted with the
 * state file) still decides the identity, so a copied journal on a new host
 * keeps its registration and a fresh journal is a genuinely new watcher that
 * the server must be told about. The authority fields still bind the id to one
 * endpoint, space, account and credential slot, so a journal pointed at a
 * different account is a different watcher.
 */
function mintWatcherId(domain: string, salt: string, payload: unknown): string {
  const bytes = createHash("sha256")
    .update(domain)
    .update(salt, "utf8")
    .update(JSON.stringify(payload), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True when two bindings name the same worker identity and differ only in the
 * configuration fingerprint.
 *
 * P2-104b: `configFingerprint` hashes the whole `pdfDocQa` block
 * (`journalBindingForConfig`), so a parser path or fingerprint edit produces a
 * binding the journal refused to open. That locked the operator out of the
 * journal directory, which also holds the archive catalog, on exactly the
 * change a parser upgrade requires. Identity is what the binding must pin;
 * the configuration fingerprint says "this journal was last written under a
 * different config", which is a fact to adopt when nothing is in flight, not
 * a reason to refuse.
 */
function sameAuthorityDifferentConfig(
  previous: JournalBinding,
  proposed: JournalBinding,
): boolean {
  return (
    previous.protocolVersion === proposed.protocolVersion &&
    previous.endpoint === proposed.endpoint &&
    previous.spaceId === proposed.spaceId &&
    previous.sourceAccountId === proposed.sourceAccountId &&
    previous.credentialSlot === proposed.credentialSlot &&
    previous.configFingerprint !== proposed.configFingerprint
  );
}

/**
 * P2-104b. Whether a journal is between passes, and so safe to rebind onto a
 * new configuration.
 *
 * Deliberately weaker than `archiveCheckpointIsQuiescent`, which additionally
 * requires the last pass to have ended `complete`. That is right for moving an
 * archive root, and wrong here: a pass that ends `incomplete` because some
 * documents are parked is finished, nothing is in flight, and the next pass
 * starts a new scan whatever the previous outcome was. Requiring `complete`
 * would mean a worker with one parked document could never take a new parser,
 * which is the failure this change exists to remove.
 *
 * What it does require is that no scan or job is half done, because a pass
 * resumed under a different parser would mix two fingerprints inside one scan.
 * Metadata-first's refreshed `deferred_idle` is also a pass boundary: it has
 * no pending request or credential session, and its exact carry starts the
 * next scan without changing any already-published artifact.
 */
function betweenPasses(state: StoredState): boolean {
  if (state.pending !== undefined || state.credentialSessionActive)
    return false;
  const checkpoint = state.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  )
    return false;
  const phase = (checkpoint as Record<string, JsonValue>).phase;
  if (phase === "idle" || phase === "terminal") return true;
  if (phase !== "archived") return false;
  const archived = checkpoint as Record<string, JsonValue>;
  const metadataFirst = archived.metadataFirst;
  return (
    archived.step === "deferred_idle" &&
    metadataFirst !== null &&
    typeof metadataFirst === "object" &&
    !Array.isArray(metadataFirst) &&
    (metadataFirst as Record<string, JsonValue>).refreshReady === true
  );
}

export function archiveCheckpointIsQuiescent(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    return false;
  if (value.phase === "idle") return true;
  return (
    value.phase === "terminal" &&
    value.outcome === "complete" &&
    value.code === undefined &&
    value.credentialSessionActive === false
  );
}
function parseRequestBody(
  body: unknown,
  operation: JournalOperation,
  requestId: string,
  binding: JournalBinding,
): string {
  const requestBody = boundedString(body, MAX_REQUEST_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    fail("pending request body is not JSON");
  }
  const request = normalizeJson(parsed, MAX_REQUEST_BODY_BYTES);
  if (!request || Array.isArray(request) || typeof request !== "object")
    fail("pending request body is not an object");
  if (
    request.protocolVersion !== 1 ||
    request.operation !== operation ||
    request.requestId !== requestId ||
    request.spaceId !== binding.spaceId ||
    request.sourceAccountId !== binding.sourceAccountId
  )
    fail("pending request identity does not match its body");
  return requestBody;
}

function parseResult(
  value: unknown,
  operation: JournalOperation,
  parse: (operation: JournalOperation, value: unknown) => JsonValue,
): StoredResult {
  const record = exactObject(value, ["value", "digest", "receivedAt"]);
  const normalized = normalizeJson(record.value, MAX_RESULT_BYTES);
  const digest = boundedString(record.digest, 64, HEX_64);
  if (sha256Hex(JSON.stringify(normalized)) !== digest)
    fail("cached result digest does not match");
  let validated: JsonValue;
  try {
    validated = parse(operation, normalized);
  } catch {
    fail("cached result is invalid");
  }
  return {
    value: normalizeJson(validated, MAX_RESULT_BYTES),
    digest,
    receivedAt: safeInteger(record.receivedAt),
  };
}
function parsePending(
  value: unknown,
  binding: JournalBinding,
  parse: (operation: JournalOperation, value: unknown) => JsonValue,
): StoredPending {
  const record = exactObject(
    value,
    ["operation", "requestId", "requestBody", "requestDigest", "createdAt"],
    ["result"],
  );
  const operation = parseOperation(record.operation);
  const requestId = boundedString(record.requestId, 128);
  const requestBody = parseRequestBody(
    record.requestBody,
    operation,
    requestId,
    binding,
  );
  const requestDigest = boundedString(record.requestDigest, 64, HEX_64);
  if (sha256Hex(requestBody) !== requestDigest)
    fail("pending request digest does not match");
  return {
    operation,
    requestId,
    requestBody,
    requestDigest,
    createdAt: safeInteger(record.createdAt),
    ...(record.result === undefined
      ? {}
      : { result: parseResult(record.result, operation, parse) }),
  };
}
function parseState<C extends JsonValue, R extends JsonValue>(
  value: unknown,
  codec: JournalCodec<C, R>,
): { state: StoredState; checkpoint: C; result?: R } {
  const record = exactObject(
    value,
    [
      "version",
      "binding",
      "credentialSalt",
      "credentialFingerprint",
      "credentialSessionActive",
      "checkpoint",
    ],
    ["pending"],
  );
  if (record.version !== 1) fail("journal version is invalid");
  const checkpointJson = normalizeJson(record.checkpoint, MAX_CHECKPOINT_BYTES);
  let checkpoint: C;
  try {
    checkpoint = codec.parseCheckpoint(checkpointJson);
  } catch {
    fail("journal checkpoint is invalid");
  }
  const normalizedCheckpoint = normalizeJson(checkpoint, MAX_CHECKPOINT_BYTES);
  const binding = parseBinding(record.binding);
  const pending =
    record.pending === undefined
      ? undefined
      : parsePending(record.pending, binding, (operation, entry) =>
          codec.parseResult(operation, entry),
        );
  let result: R | undefined;
  if (pending?.result) {
    try {
      result = codec.parseResult(pending.operation, pending.result.value);
    } catch {
      fail("cached result is invalid");
    }
  }
  return {
    state: {
      version: 1,
      binding,
      credentialSalt: boundedString(record.credentialSalt, 43, SALT),
      credentialFingerprint: boundedString(
        record.credentialFingerprint,
        64,
        HEX_64,
      ),
      credentialSessionActive: boolean(record.credentialSessionActive),
      checkpoint: normalizedCheckpoint,
      ...(pending === undefined ? {} : { pending }),
    },
    checkpoint,
    ...(result === undefined ? {} : { result }),
  };
}

function fingerprintCredential(salt: string, credential: string): string {
  if (credential.length === 0 || Buffer.byteLength(credential, "utf8") > 8_192)
    fail("credential is invalid");
  const bytes = Buffer.from(credential, "utf8");
  try {
    return createHash("sha256")
      .update("kithmind-worker-credential:v1\0")
      .update(salt)
      .update(bytes)
      .digest("hex");
  } finally {
    bytes.fill(0);
  }
}
function fingerprintsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
function assertOwned(stats: Stats, mode: number, kind: "directory" | "file") {
  const uid = process.getuid?.();
  if (uid === undefined || stats.uid !== uid)
    fail(`${kind} ownership is invalid`);
  if ((stats.mode & 0o777) !== mode) fail(`${kind} permissions are invalid`);
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile())
    fail(`${kind} type is invalid`);
}
async function readHandleBounded(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_STATE_BYTES)
    fail("journal file size is invalid");
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) fail("journal file changed while reading");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    buffer.subarray(0, offset),
  );
}
async function readStoredState(path: string): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_NONBLOCK !== "number"
    )
      fail("required POSIX open flags are unavailable");
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("journal state cannot be opened safely");
  }
  try {
    const stats = await handle.stat();
    assertOwned(stats, FILE_MODE, "file");
    const raw = await readHandleBounded(handle, stats.size);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      fail("journal state is not JSON");
    }
  } finally {
    await handle.close();
  }
}
async function fsyncDirectory(path: string): Promise<void> {
  if (typeof constants.O_DIRECTORY !== "number")
    fail("required POSIX directory flag is unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function serializeState(state: StoredState): string {
  return `${JSON.stringify(normalizeJson(state, MAX_STATE_BYTES))}\n`;
}

function lockPort(key: string): number {
  const digest = createHash("sha256").update(key).digest();
  return LOCK_PORT_BASE + (digest.readUInt16BE(0) % LOCK_PORT_COUNT);
}
function authorityLockKey(binding: JournalBinding): string {
  return JSON.stringify([
    "authority:v1",
    new URL(binding.endpoint).origin,
    binding.spaceId,
    binding.sourceAccountId,
  ]);
}
function journalPathLockKey(directory: string): string {
  return JSON.stringify(["journal-path:v1", directory]);
}
async function acquireLock(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: "127.0.0.1",
        port,
        exclusive: true,
      });
    });
    return server;
  } catch {
    try {
      server.close();
    } catch {
      /* Listener did not become active. */
    }
    throw new JournalLockedError();
  }
}
async function acquireLocks(
  binding: JournalBinding,
  directory: string,
): Promise<Server[]> {
  const ports = [
    ...new Set([
      lockPort(authorityLockKey(binding)),
      lockPort(journalPathLockKey(directory)),
    ]),
  ].sort((left, right) => left - right);
  const servers: Server[] = [];
  try {
    for (const port of ports) servers.push(await acquireLock(port));
    return servers;
  } catch (error) {
    await Promise.allSettled(
      servers.map(async (server) => closeServer(server)),
    );
    throw error;
  }
}
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}
async function closeServers(servers: readonly Server[]): Promise<void> {
  const results = await Promise.allSettled(
    [...servers].reverse().map(async (server) => closeServer(server)),
  );
  if (results.some((result) => result.status === "rejected"))
    fail("journal locks could not be released");
}

type InspectionUnsafeCode = Extract<
  JournalInspection,
  { state: "unsafe" }
>["code"];

class InspectionFailure extends Error {
  constructor(readonly code: InspectionUnsafeCode) {
    super("Journal inspection failed");
  }
}

function inspectionFailure(code: InspectionUnsafeCode): never {
  throw new InspectionFailure(code);
}

function requireInspectionDirectory(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    inspectionFailure("invalid_directory");
  }
  const uid = process.getuid?.();
  if (uid === undefined) inspectionFailure("unsupported_platform");
  if (stats.uid !== uid || (stats.mode & 0o777) !== DIRECTORY_MODE) {
    inspectionFailure("invalid_permissions");
  }
}

function requireInspectionFile(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    inspectionFailure("invalid_state");
  }
  const uid = process.getuid?.();
  if (uid === undefined) inspectionFailure("unsupported_platform");
  if (stats.uid !== uid || (stats.mode & 0o777) !== FILE_MODE) {
    inspectionFailure("invalid_permissions");
  }
}

async function requireCreatableJournalParent(path: string): Promise<void> {
  if (
    typeof constants.W_OK !== "number" ||
    typeof constants.X_OK !== "number"
  ) {
    inspectionFailure("unsupported_platform");
  }
  let candidate = path;
  for (let inspected = 0; inspected < 256; inspected += 1) {
    if (Buffer.byteLength(candidate, "utf8") > 8_192) {
      inspectionFailure("capacity_exceeded");
    }
    try {
      const entry = await lstat(candidate);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        inspectionFailure("invalid_directory");
      }
      let canonicalEntry: Stats;
      try {
        canonicalEntry = await lstat(canonical);
      } catch {
        inspectionFailure("invalid_directory");
      }
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        !canonicalEntry.isDirectory() ||
        canonicalEntry.isSymbolicLink()
      ) {
        inspectionFailure("invalid_directory");
      }
      try {
        await access(canonical, constants.W_OK | constants.X_OK);
      } catch {
        inspectionFailure("invalid_permissions");
      }
      return;
    } catch (error) {
      if (error instanceof InspectionFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        inspectionFailure(
          (error as NodeJS.ErrnoException).code === "EACCES"
            ? "invalid_permissions"
            : "invalid_directory",
        );
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) inspectionFailure("invalid_directory");
    candidate = parent;
  }
  inspectionFailure("capacity_exceeded");
}

async function requireStableInspectionDirectory(
  requestedDirectory: string,
  directory: string,
  identity: Pick<Stats, "dev" | "ino">,
): Promise<void> {
  try {
    const requestedStats = await lstat(requestedDirectory);
    requireInspectionDirectory(requestedStats);
    if ((await realpath(requestedDirectory)) !== directory) {
      inspectionFailure("invalid_directory");
    }
    const currentStats = await lstat(directory);
    requireInspectionDirectory(currentStats);
    if (
      requestedStats.dev !== identity.dev ||
      requestedStats.ino !== identity.ino ||
      currentStats.dev !== identity.dev ||
      currentStats.ino !== identity.ino
    ) {
      inspectionFailure("invalid_directory");
    }
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    inspectionFailure("invalid_directory");
  }
}

function inspectionActivity(
  value: JsonValue,
): Extract<JournalInspection, { state: "safe" }>["activity"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    inspectionFailure("invalid_state");
  }
  const phase = (value as Record<string, JsonValue>).phase;
  if (phase === "idle") return "idle";
  if (phase === "terminal") return "terminal";
  if (
    phase === "scan_begin" ||
    phase === "inventory" ||
    phase === "append" ||
    phase === "seal_check" ||
    phase === "seal" ||
    phase === "reconcile" ||
    phase === "discovery_reserve" ||
    phase === "discovery_admit"
  ) {
    return "scan";
  }
  if (
    phase === "jobs_reserve" ||
    phase === "jobs_renew" ||
    phase === "jobs_stage" ||
    phase === "jobs_activate" ||
    phase === "jobs_fail" ||
    phase === "archived"
  ) {
    return "processing";
  }
  if (
    phase === "assess_status" ||
    phase === "assess_begin" ||
    phase === "assess_page"
  ) {
    return "assessment";
  }
  inspectionFailure("invalid_state");
}

function manualRecoveryRequired(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.phase === "terminal" &&
    value.code === "request_conflict"
  );
}

/**
 * ADM-6a. Whether the last pass refused itself because this journal disagrees
 * with the server about what the source holds.
 *
 * Only this one code, and not the two ADM-4c refusals beside it. Those clear
 * themselves: the disk comes back, the folder mounts, and the next pass runs.
 * This one does not. It says the journal is not this source's journal, which
 * stays true however many passes run, so it is a standing condition `doctor`
 * has to name -- and naming a self-clearing refusal there would teach the
 * owner to ignore the check.
 */
function journalBehindServer(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.phase === "terminal" &&
    value.code === "journal_behind_server"
  );
}

async function inspectDirectoryEntries(directory: string): Promise<number> {
  let inspected = 0;
  let recoveryArtifactCount = 0;
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(directory);
  } catch {
    inspectionFailure("invalid_directory");
  }
  try {
    for await (const entry of entries) {
      inspected += 1;
      if (inspected > 64) inspectionFailure("capacity_exceeded");
      if (entry.name !== STATE_FILE && !TEMP_FILE.test(entry.name)) continue;
      let stats: Stats;
      try {
        stats = await lstat(join(directory, entry.name));
      } catch {
        inspectionFailure("invalid_state");
      }
      requireInspectionFile(stats);
      if (entry.name !== STATE_FILE) recoveryArtifactCount += 1;
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  return recoveryArtifactCount;
}

async function inspectExistingJournal<C extends JsonValue, R extends JsonValue>(
  requestedDirectory: string,
  binding: JournalBinding,
  codec: JournalCodec<C, R>,
  credentialForComparison: string | undefined,
): Promise<JournalInspection> {
  let locks: Server[] = [];
  let result: JournalInspection;
  try {
    let requestedStats: Stats;
    try {
      requestedStats = await lstat(requestedDirectory);
    } catch {
      inspectionFailure("invalid_directory");
    }
    requireInspectionDirectory(requestedStats);
    let directory: string;
    try {
      directory = await realpath(requestedDirectory);
    } catch {
      inspectionFailure("invalid_directory");
    }
    let directoryStats: Stats;
    try {
      directoryStats = await lstat(directory);
    } catch {
      inspectionFailure("invalid_directory");
    }
    requireInspectionDirectory(directoryStats);
    const directoryIdentity = {
      dev: directoryStats.dev,
      ino: directoryStats.ino,
    };
    try {
      locks = await acquireLocks(binding, directory);
    } catch (error) {
      if (error instanceof JournalLockedError) return { state: "contended" };
      throw error;
    }
    await requireStableInspectionDirectory(
      requestedDirectory,
      directory,
      directoryIdentity,
    );
    const recoveryArtifactCount = await inspectDirectoryEntries(directory);
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_NONBLOCK !== "number"
    ) {
      inspectionFailure("unsupported_platform");
    }
    let stored: unknown | undefined;
    try {
      stored = await readStoredState(join(directory, STATE_FILE));
    } catch {
      inspectionFailure("invalid_state");
    }
    if (stored === undefined) {
      result = { state: "not_initialized" };
    } else {
      let parsed: ReturnType<typeof parseState<C, R>>;
      try {
        parsed = parseState(stored, codec);
      } catch {
        inspectionFailure("invalid_state");
      }
      // P2-104b: mirrors `open`. A configuration change over the same worker
      // identity is reported, not treated as an unsafe journal, so `doctor`
      // says which of the two it is instead of refusing to look further.
      let configBinding: Extract<
        JournalInspection,
        { state: "safe" }
      >["configBinding"] = "current";
      if (!bindingEqual(parsed.state.binding, binding)) {
        if (!sameAuthorityDifferentConfig(parsed.state.binding, binding)) {
          inspectionFailure("binding_mismatch");
        }
        configBinding = betweenPasses(parsed.state)
          ? "changed_quiescent"
          : "changed_active";
      }
      let credentialBinding: Extract<
        JournalInspection,
        { state: "safe" }
      >["credentialBinding"] = "unverified";
      if (credentialForComparison !== undefined) {
        let candidate: string;
        try {
          candidate = fingerprintCredential(
            parsed.state.credentialSalt,
            credentialForComparison,
          );
        } catch {
          inspectionFailure("invalid_state");
        }
        if (fingerprintsEqual(parsed.state.credentialFingerprint, candidate)) {
          credentialBinding = "current";
        } else if (
          parsed.state.pending !== undefined ||
          parsed.state.credentialSessionActive
        ) {
          credentialBinding = "changed_active";
        } else {
          credentialBinding = "changed_quiescent";
        }
      }
      result = {
        state: "safe",
        activity: inspectionActivity(parsed.checkpoint),
        pending: parsed.state.pending !== undefined,
        cachedResult: parsed.state.pending?.result !== undefined,
        credentialSessionActive: parsed.state.credentialSessionActive,
        credentialBinding,
        configBinding,
        recoveryArtifactCount,
        manualRecoveryRequired: manualRecoveryRequired(parsed.checkpoint),
        journalBehindServer: journalBehindServer(parsed.checkpoint),
      };
    }
    await requireStableInspectionDirectory(
      requestedDirectory,
      directory,
      directoryIdentity,
    );
  } catch (error) {
    result = {
      state: "unsafe",
      code: error instanceof InspectionFailure ? error.code : "invalid_state",
    };
  }
  try {
    await closeServers(locks);
  } catch {
    return { state: "unsafe", code: "invalid_state" };
  }
  return result!;
}

export async function inspectJournalReadOnly<
  C extends JsonValue,
  R extends JsonValue,
>(args: {
  directory: string;
  binding: JournalBinding;
  codec: JournalCodec<C, R>;
  credentialForComparison?: string;
}): Promise<JournalInspection> {
  let binding: JournalBinding;
  try {
    binding = parseBinding(args.binding);
  } catch {
    return { state: "unsafe", code: "invalid_state" };
  }
  if (process.getuid?.() === undefined) {
    return { state: "unsafe", code: "unsupported_platform" };
  }
  const requestedDirectory = resolve(args.directory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lstat(requestedDirectory);
      return await inspectExistingJournal(
        requestedDirectory,
        binding,
        args.codec,
        args.credentialForComparison,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          state: "unsafe",
          code:
            (error as NodeJS.ErrnoException).code === "EACCES"
              ? "invalid_permissions"
              : "invalid_directory",
        };
      }
    }
    let authorityLock: Server;
    try {
      authorityLock = await acquireLock(lockPort(authorityLockKey(binding)));
    } catch (error) {
      if (error instanceof JournalLockedError) return { state: "contended" };
      return { state: "unsafe", code: "invalid_state" };
    }
    let appeared = false;
    let missingResult: JournalInspection | undefined;
    try {
      try {
        await lstat(requestedDirectory);
        appeared = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          missingResult = {
            state: "unsafe",
            code:
              (error as NodeJS.ErrnoException).code === "EACCES"
                ? "invalid_permissions"
                : "invalid_directory",
          };
        }
      }
      if (!appeared && missingResult === undefined) {
        try {
          await requireCreatableJournalParent(requestedDirectory);
          missingResult = { state: "not_initialized" };
        } catch (error) {
          missingResult = {
            state: "unsafe",
            code:
              error instanceof InspectionFailure ? error.code : "invalid_state",
          };
        }
      }
    } finally {
      try {
        await closeServer(authorityLock);
      } catch {
        return { state: "unsafe", code: "invalid_state" };
      }
    }
    if (!appeared) return missingResult!;
  }
  return { state: "unsafe", code: "invalid_directory" };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: Pick<Stats, "dev" | "ino">,
): Promise<void> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink()) fail("directory is a symlink");
  assertOwned(stats, DIRECTORY_MODE, "directory");
  if (stats.dev !== expected.dev || stats.ino !== expected.ino)
    fail("journal directory identity changed");
}
async function cleanInterruptedTemps(directory: string): Promise<void> {
  let changed = false;
  let inspected = 0;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    inspected += 1;
    if (inspected > 64) fail("journal directory has too many entries");
    const name = entry.name;
    if (name === STATE_FILE) continue;
    if (!TEMP_FILE.test(name)) continue;
    const path = join(directory, name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) fail("temporary journal entry is a symlink");
    assertOwned(stats, FILE_MODE, "file");
    await unlink(path);
    changed = true;
  }
  if (changed) await fsyncDirectory(directory);
}

export class Journal<C extends JsonValue, R extends JsonValue> {
  readonly directory: string;
  readonly binding: JournalBinding;
  readonly watcherId: string;
  /**
   * ADM-10. The `v1` id this journal would have computed, presented beside
   * `watcherId` so a watcher already registered under it keeps its
   * registration. See `mintWatcherId`.
   */
  readonly legacyWatcherId: string;
  private readonly statePath: string;
  private readonly codec: JournalCodec<C, R>;
  private locks: Server[];
  private readonly directoryIdentity: Pick<Stats, "dev" | "ino">;
  private state: StoredState;
  private parsedCheckpoint: C;
  private parsedResult?: R;
  private candidateCredentialFingerprint?: string;
  private poisoned = false;
  private closed = false;

  private constructor(args: {
    directory: string;
    binding: JournalBinding;
    codec: JournalCodec<C, R>;
    locks: Server[];
    directoryIdentity: Pick<Stats, "dev" | "ino">;
    state: StoredState;
    checkpoint: C;
    result?: R;
    candidateCredentialFingerprint?: string;
  }) {
    this.directory = args.directory;
    this.statePath = join(args.directory, STATE_FILE);
    this.binding = args.binding;
    this.watcherId = mintWatcherId(
      "kithmind-worker-heartbeat:v2\0",
      args.state.credentialSalt,
      authorityOf(args.binding),
    );
    this.legacyWatcherId = mintWatcherId(
      "kithmind-worker-heartbeat:v1\0",
      args.state.credentialSalt,
      args.binding,
    );
    this.codec = args.codec;
    this.locks = args.locks;
    this.directoryIdentity = args.directoryIdentity;
    this.state = args.state;
    this.parsedCheckpoint = args.checkpoint;
    this.parsedResult = args.result;
    this.candidateCredentialFingerprint = args.candidateCredentialFingerprint;
  }

  static async open<C extends JsonValue, R extends JsonValue>(args: {
    directory: string;
    binding: JournalBinding;
    credential: string;
    initialCheckpoint: C;
    codec: JournalCodec<C, R>;
  }): Promise<Journal<C, R>> {
    const binding = parseBinding(args.binding);
    const requestedDirectory = resolve(args.directory);
    let locks: Server[] = [];
    try {
      await mkdir(requestedDirectory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      const requestedStats = await lstat(requestedDirectory);
      if (requestedStats.isSymbolicLink()) fail("directory is a symlink");
      assertOwned(requestedStats, DIRECTORY_MODE, "directory");
      const directory = await realpath(requestedDirectory);
      const directoryStats = await lstat(directory);
      assertOwned(directoryStats, DIRECTORY_MODE, "directory");
      const directoryIdentity = {
        dev: directoryStats.dev,
        ino: directoryStats.ino,
      };
      locks = await acquireLocks(binding, directory);
      if ((await realpath(requestedDirectory)) !== directory)
        fail("journal directory path changed");
      await assertDirectoryIdentity(directory, directoryIdentity);
      await cleanInterruptedTemps(directory);
      await assertDirectoryIdentity(directory, directoryIdentity);
      const stored = await readStoredState(join(directory, STATE_FILE));
      if (stored === undefined) {
        let checkpoint: C;
        try {
          checkpoint = args.codec.parseCheckpoint(args.initialCheckpoint);
        } catch {
          fail("initial checkpoint is invalid");
        }
        const salt = randomBytes(32).toString("base64url");
        const state: StoredState = {
          version: 1,
          binding,
          credentialSalt: salt,
          credentialFingerprint: fingerprintCredential(salt, args.credential),
          credentialSessionActive: false,
          checkpoint: normalizeJson(checkpoint, MAX_CHECKPOINT_BYTES),
        };
        const journal = new Journal<C, R>({
          directory,
          binding,
          codec: args.codec,
          locks,
          directoryIdentity,
          state,
          checkpoint,
        });
        await journal.persistCandidate(state);
        return journal;
      }
      const parsed = parseState(stored, args.codec);
      // P2-104b: a journal written under a different configuration reopens
      // when the worker identity is unchanged and nothing is in flight. The
      // new binding is adopted and persisted here, so the next open is an
      // ordinary equal-binding open. Anything else, including a changed
      // endpoint, space, account or credential slot, still refuses: those name
      // a different worker, and its journal is not this one's to continue.
      const adoptConfigBinding = !bindingEqual(parsed.state.binding, binding);
      if (
        adoptConfigBinding &&
        !(
          sameAuthorityDifferentConfig(parsed.state.binding, binding) &&
          betweenPasses(parsed.state)
        )
      )
        fail("journal binding changed");
      const candidateFingerprint = fingerprintCredential(
        parsed.state.credentialSalt,
        args.credential,
      );
      const changed = !fingerprintsEqual(
        parsed.state.credentialFingerprint,
        candidateFingerprint,
      );
      if (
        changed &&
        (parsed.state.pending !== undefined ||
          parsed.state.credentialSessionActive)
      )
        throw new JournalCredentialChangedError();
      const state: StoredState = adoptConfigBinding
        ? { ...parsed.state, binding }
        : parsed.state;
      const journal = new Journal<C, R>({
        directory,
        binding,
        codec: args.codec,
        locks,
        directoryIdentity,
        state,
        checkpoint: parsed.checkpoint,
        result: parsed.result,
        ...(changed
          ? { candidateCredentialFingerprint: candidateFingerprint }
          : {}),
      });
      if (adoptConfigBinding) {
        // Durable before the first transition, and read back, so a crash here
        // cannot leave the state file naming a configuration no longer in use.
        await journal.persistCandidate(state);
        const storedAfter = await readStoredState(join(directory, STATE_FILE));
        if (
          storedAfter === undefined ||
          serializeState(parseState(storedAfter, args.codec).state) !==
            serializeState(state)
        )
          fail("journal binding rebind readback changed");
      }
      return journal;
    } catch (error) {
      await closeServers(locks).catch(() => undefined);
      if (
        error instanceof JournalSafetyError ||
        error instanceof JournalLockedError ||
        error instanceof JournalCredentialChangedError
      )
        throw error;
      throw new JournalSafetyError("journal could not be opened safely");
    }
  }

  /**
   * Opens an existing journal under one exact root-only configuration rebind.
   * Unlike open(), this entrypoint never initializes a missing state file.
   */
  static async openExistingForArchiveRebind<
    C extends JsonValue,
    R extends JsonValue,
  >(args: {
    directory: string;
    previousConfig: unknown;
    proposedConfig: unknown;
    credential: string;
    codec: JournalCodec<C, R>;
  }): Promise<Journal<C, R>> {
    const validated = validateArchiveRelocationConfig(
      args.previousConfig,
      args.proposedConfig,
    );
    const previousBinding = parseBinding(validated.previousBinding);
    const proposedBinding = parseBinding(validated.proposedBinding);
    if (!sameAuthorityDifferentConfig(previousBinding, proposedBinding))
      fail("archive rebind bindings are invalid");
    const requestedDirectory = resolve(args.directory);
    let locks: Server[] = [];
    try {
      const requestedStats = await lstat(requestedDirectory);
      if (requestedStats.isSymbolicLink()) fail("directory is a symlink");
      assertOwned(requestedStats, DIRECTORY_MODE, "directory");
      const directory = await realpath(requestedDirectory);
      const directoryStats = await lstat(directory);
      assertOwned(directoryStats, DIRECTORY_MODE, "directory");
      const directoryIdentity = {
        dev: directoryStats.dev,
        ino: directoryStats.ino,
      };
      locks = await acquireLocks(previousBinding, directory);
      if ((await realpath(requestedDirectory)) !== directory)
        fail("journal directory path changed");
      await assertDirectoryIdentity(directory, directoryIdentity);
      await cleanInterruptedTemps(directory);
      await assertDirectoryIdentity(directory, directoryIdentity);
      const stored = await readStoredState(join(directory, STATE_FILE));
      if (stored === undefined) fail("archive rebind journal is missing");
      const parsed = parseState(stored, args.codec);
      if (
        !bindingEqual(parsed.state.binding, previousBinding) &&
        !bindingEqual(parsed.state.binding, proposedBinding)
      )
        fail("archive rebind journal binding is unexpected");
      const candidateFingerprint = fingerprintCredential(
        parsed.state.credentialSalt,
        args.credential,
      );
      if (
        !fingerprintsEqual(
          parsed.state.credentialFingerprint,
          candidateFingerprint,
        )
      )
        throw new JournalCredentialChangedError();
      if (
        parsed.state.pending !== undefined ||
        parsed.state.credentialSessionActive ||
        !archiveCheckpointIsQuiescent(parsed.checkpoint)
      )
        fail("archive rebind requires a quiescent journal");
      return new Journal<C, R>({
        directory,
        binding: parsed.state.binding,
        codec: args.codec,
        locks,
        directoryIdentity,
        state: parsed.state,
        checkpoint: parsed.checkpoint,
        result: parsed.result,
      });
    } catch (error) {
      await closeServers(locks).catch(() => undefined);
      if (
        error instanceof JournalSafetyError ||
        error instanceof JournalLockedError ||
        error instanceof JournalCredentialChangedError
      )
        throw error;
      throw new JournalSafetyError(
        "archive rebind journal could not be opened safely",
      );
    }
  }

  get credentialStatus(): JournalCredentialStatus {
    this.assertUsable(false);
    return this.candidateCredentialFingerprint === undefined
      ? "current"
      : "changed_quiescent";
  }
  get checkpoint(): C {
    this.assertUsable(false);
    return structuredClone(this.parsedCheckpoint);
  }
  get pending(): PendingRequest<R> | undefined {
    this.assertUsable(false);
    if (!this.state.pending) return undefined;
    return structuredClone({
      ...this.state.pending,
      ...(this.parsedResult === undefined
        ? {}
        : {
            result: {
              value: this.parsedResult,
              digest: this.state.pending.result!.digest,
              receivedAt: this.state.pending.result!.receivedAt,
            },
          }),
    }) as PendingRequest<R>;
  }
  async archiveRelocationRebindStatus(args: {
    previousConfig: unknown;
    proposedConfig: unknown;
  }): Promise<{
    state: "previous" | "proposed";
    stateSha256: string;
    previousStateSha256: string;
    proposedStateSha256: string;
  }> {
    this.assertUsable();
    const validated = validateArchiveRelocationConfig(
      args.previousConfig,
      args.proposedConfig,
    );
    const previousBinding = parseBinding(validated.previousBinding);
    const proposedBinding = parseBinding(validated.proposedBinding);
    if (
      !sameAuthorityDifferentConfig(previousBinding, proposedBinding) ||
      (!bindingEqual(this.binding, previousBinding) &&
        !bindingEqual(this.binding, proposedBinding)) ||
      this.state.pending !== undefined ||
      this.state.credentialSessionActive ||
      !archiveCheckpointIsQuiescent(this.parsedCheckpoint)
    )
      fail("archive rebind state is invalid");
    const stored = await readStoredState(this.statePath);
    if (stored === undefined) fail("archive rebind journal is missing");
    const parsed = parseState(stored, this.codec);
    if (
      !bindingEqual(parsed.state.binding, this.binding) ||
      serializeState(parsed.state) !== serializeState(this.state)
    )
      fail("archive rebind journal changed");
    const previousState = { ...this.state, binding: previousBinding };
    const proposedState = { ...this.state, binding: proposedBinding };
    return {
      state: bindingEqual(this.binding, previousBinding)
        ? "previous"
        : "proposed",
      stateSha256: sha256Hex(serializeState(this.state)),
      previousStateSha256: sha256Hex(serializeState(previousState)),
      proposedStateSha256: sha256Hex(serializeState(proposedState)),
    };
  }
  /**
   * Rewrites only the journal binding while retaining the held authority/path
   * locks. The old object is invalidated and ownership of its locks transfers
   * to the returned object, whose heartbeat identity reflects the new binding.
   */
  async rebindForArchiveRelocation(args: {
    previousConfig: unknown;
    proposedConfig: unknown;
  }): Promise<Journal<C, R>> {
    const validated = validateArchiveRelocationConfig(
      args.previousConfig,
      args.proposedConfig,
    );
    const previousBinding = parseBinding(validated.previousBinding);
    const proposedBinding = parseBinding(validated.proposedBinding);
    const status = await this.archiveRelocationRebindStatus(args);
    if (bindingEqual(this.binding, proposedBinding)) return this;
    if (status.state !== "previous") fail("archive rebind state is invalid");
    const next: StoredState = { ...this.state, binding: proposedBinding };
    await this.persistCandidate(next);
    try {
      const storedAfter = await readStoredState(this.statePath);
      if (storedAfter === undefined) fail("archive rebind journal is missing");
      const parsedAfter = parseState(storedAfter, this.codec);
      if (serializeState(parsedAfter.state) !== serializeState(next))
        fail("archive rebind journal readback changed");
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    const transferredLocks = this.locks;
    this.locks = [];
    this.closed = true;
    this.candidateCredentialFingerprint = undefined;
    this.state = next;
    return new Journal<C, R>({
      directory: this.directory,
      binding: proposedBinding,
      codec: this.codec,
      locks: transferredLocks,
      directoryIdentity: this.directoryIdentity,
      state: next,
      checkpoint: this.parsedCheckpoint,
    });
  }
  private assertUsable(requireCurrentCredential = true): void {
    if (this.closed) fail("journal is closed");
    if (this.poisoned)
      fail("journal must be reopened after a durability error");
    if (
      requireCurrentCredential &&
      this.candidateCredentialFingerprint !== undefined
    )
      throw new JournalCredentialChangedError();
  }
  private async persistCandidate(next: StoredState): Promise<void> {
    this.assertUsable(false);
    const encoded = serializeState(next);
    const temp = join(this.directory, `.${STATE_FILE}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await assertDirectoryIdentity(this.directory, this.directoryIdentity);
      const handle = await open(temp, "wx", FILE_MODE);
      try {
        assertOwned(await handle.stat(), FILE_MODE, "file");
        await handle.writeFile(encoded, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.statePath);
      renamed = true;
      await fsyncDirectory(this.directory);
    } catch {
      this.poisoned = true;
      if (!renamed) await unlink(temp).catch(() => undefined);
      throw new JournalSafetyError("durability operation failed");
    }
  }

  async planRequest(request: PlanRequest): Promise<PendingRequest<R>> {
    this.assertUsable();
    if (this.state.pending) fail("a request is already unresolved");
    const operation = parseOperation(request.operation);
    const requestId = boundedString(request.requestId, 128);
    const requestBody = parseRequestBody(
      request.requestBody,
      operation,
      requestId,
      this.binding,
    );
    const pending: StoredPending = {
      operation,
      requestId,
      requestBody,
      requestDigest: sha256Hex(requestBody),
      createdAt: safeInteger(request.createdAt),
    };
    const next = { ...this.state, pending };
    await this.persistCandidate(next);
    this.state = next;
    this.parsedResult = undefined;
    return this.pending!;
  }
  async recordValidatedResult(value: unknown, receivedAt: number): Promise<R> {
    this.assertUsable();
    const pending = this.state.pending;
    if (!pending) fail("there is no unresolved request");
    if (pending.result) fail("the request result is already durable");
    let parsed: R;
    try {
      parsed = this.codec.parseResult(pending.operation, value);
    } catch {
      fail("request result is invalid");
    }
    const normalized = normalizeJson(parsed, MAX_RESULT_BYTES);
    const result: StoredResult = {
      value: normalized,
      digest: sha256Hex(JSON.stringify(normalized)),
      receivedAt: safeInteger(receivedAt),
    };
    const next: StoredState = {
      ...this.state,
      pending: { ...pending, result },
    };
    await this.persistCandidate(next);
    this.state = next;
    this.parsedResult = structuredClone(parsed);
    return structuredClone(parsed);
  }
  async commitResult(transition: CheckpointTransition<C>): Promise<void> {
    this.assertUsable();
    if (!this.state.pending?.result || this.parsedResult === undefined)
      fail("a validated durable result is required");
    let parsedCheckpoint: C;
    try {
      parsedCheckpoint = this.codec.parseCheckpoint(transition.checkpoint);
    } catch {
      fail("next checkpoint is invalid");
    }
    const { pending: _completed, ...retained } = this.state;
    const next: StoredState = {
      ...retained,
      checkpoint: normalizeJson(parsedCheckpoint, MAX_CHECKPOINT_BYTES),
      credentialSessionActive: boolean(transition.credentialSessionActive),
    };
    await this.persistCandidate(next);
    this.state = next;
    this.parsedCheckpoint = structuredClone(parsedCheckpoint);
    this.parsedResult = undefined;
  }
  /**
   * One bounded active-pass config transition. The caller owns the exact
   * allowed config delta and checkpoint policy. This method makes any
   * answered-request settlement, checkpoint transition, and binding adoption
   * one durable write.
   */
  async commitActiveConfigTransition(args: {
    previousBinding: JournalBinding;
    proposedBinding: JournalBinding;
    checkpoint: C;
    credentialSessionActive: boolean;
  }): Promise<Journal<C, R>> {
    this.assertUsable();
    const previous = parseBinding(args.previousBinding);
    const proposed = parseBinding(args.proposedBinding);
    if (
      !bindingEqual(this.binding, previous) ||
      !sameAuthorityDifferentConfig(previous, proposed) ||
      (this.state.pending !== undefined &&
        (!this.state.pending.result || this.parsedResult === undefined))
    )
      fail("active config transition state is invalid");
    let checkpoint: C;
    try {
      checkpoint = this.codec.parseCheckpoint(args.checkpoint);
    } catch {
      fail("active config transition checkpoint is invalid");
    }
    const { pending: _completed, ...retained } = this.state;
    const next: StoredState = {
      ...retained,
      binding: proposed,
      checkpoint: normalizeJson(checkpoint, MAX_CHECKPOINT_BYTES),
      credentialSessionActive: boolean(args.credentialSessionActive),
    };
    await this.persistCandidate(next);
    const storedAfter = await readStoredState(this.statePath);
    if (storedAfter === undefined)
      fail("active config transition journal is missing");
    const parsedAfter = parseState(storedAfter, this.codec);
    if (serializeState(parsedAfter.state) !== serializeState(next)) {
      this.poisoned = true;
      fail("active config transition journal readback changed");
    }
    const transferredLocks = this.locks;
    this.locks = [];
    this.closed = true;
    this.state = next;
    this.parsedCheckpoint = checkpoint;
    this.parsedResult = undefined;
    return new Journal<C, R>({
      directory: this.directory,
      binding: proposed,
      codec: this.codec,
      locks: transferredLocks,
      directoryIdentity: this.directoryIdentity,
      state: next,
      checkpoint,
    });
  }
  async transitionCheckpoint(
    transition: CheckpointTransition<C>,
  ): Promise<void> {
    this.assertUsable();
    if (this.state.pending)
      fail("cannot transition with an unresolved request");
    let parsedCheckpoint: C;
    try {
      parsedCheckpoint = this.codec.parseCheckpoint(transition.checkpoint);
    } catch {
      fail("next checkpoint is invalid");
    }
    const next: StoredState = {
      ...this.state,
      checkpoint: normalizeJson(parsedCheckpoint, MAX_CHECKPOINT_BYTES),
      credentialSessionActive: boolean(transition.credentialSessionActive),
    };
    await this.persistCandidate(next);
    this.state = next;
    this.parsedCheckpoint = structuredClone(parsedCheckpoint);
  }
  async acceptCredentialAfterAuthorizedStatus(): Promise<void> {
    this.assertUsable(false);
    if (this.candidateCredentialFingerprint === undefined) return;
    if (this.state.pending || this.state.credentialSessionActive)
      throw new JournalCredentialChangedError();
    const next: StoredState = {
      ...this.state,
      credentialFingerprint: this.candidateCredentialFingerprint,
    };
    await this.persistCandidate(next);
    this.state = next;
    this.candidateCredentialFingerprint = undefined;
  }
  /**
   * Best-effort diagnostic breadcrumb for an unclassified `runSafely`
   * failure, written next to `state.json` as `failure.json`. Never part of
   * the checkpoint/replay state machine: a write failure here is swallowed
   * rather than poisoning the journal or masking the original error, and a
   * later successful pass simply leaves the stale file in place (it is a
   * "last failure seen" breadcrumb, not a cleared alert).
   */
  async recordFailure(detail: Record<string, JsonValue>): Promise<void> {
    try {
      const body = JSON.stringify({
        ...detail,
        recordedAt: Date.now(),
      }).slice(0, MAX_FAILURE_RECORD_BYTES);
      await writeFile(join(this.directory, FAILURE_FILE), body, {
        mode: FILE_MODE,
      });
    } catch {
      // Diagnostics only; never let this failure compound the original one.
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.candidateCredentialFingerprint = undefined;
    await closeServers(this.locks);
    this.closed = true;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
