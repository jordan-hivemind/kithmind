// Reuses the old durable filesystem worker's file identities so a first run
// against an already-indexed folder does not register every file as new.
//
// The old worker (`packages/pipeline`/`packages/kith-store/src/workers`,
// frozen per docs/plans/2026-09-22-simplification-and-feeds.md) journaled a
// per-root identity registry in its `state.json`: an `IdentityBinding` array
// (`packages/pipeline/src/types.ts`) of `{ rootAlias, relativePath,
// externalId, providerFileId? }`, where `externalId` is the random UUID that
// became `kith.source_items.external_id` for that file. This module reads
// that same array -- read-only, this package never writes a worker journal
// -- and turns it into a `relativePath -> externalId` lookup this package's
// own `externalId` (`relativePath`, see ingest.ts) can be overridden with, so
// a file the old worker already registered keeps its `kith.source_items` row
// instead of ingest-simple minting a second one under a path-derived id.
//
// This file intentionally does not import anything from `packages/pipeline`
// (a side lane must stay out of that package -- AGENTS.md) or depend on the
// worker's own journal codec. It re-validates the shape independently, the
// same way `packages/pipeline/src/runnerState.ts`'s `bindings()` validates
// `IdentityBinding[]` (UUID external ids, unique paths, unique external ids,
// no unrecognized keys) -- so a malformed or foreign file fails closed with a
// clear message instead of silently contributing wrong identities.

import { readFile } from "node:fs/promises";

/** Mirrors `packages/pipeline/src/runnerState.ts`'s `ROOT_ALIAS`. */
const ROOT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Mirrors `packages/pipeline/src/runnerState.ts`'s `UUID`: the pattern a
 * worker-issued `externalId` was validated against when the journal was
 * written, so a value that does not match one was never a real binding. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Mirrors `packages/pipeline/src/runnerState.ts`'s `PROVIDER_FILE_ID`. */
const PROVIDER_FILE_ID_PATTERN = /^[A-Za-z0-9:._-]{1,256}$/;
/** Mirrors `packages/pipeline/src/runnerState.ts`'s `MAX_PATH_BYTES`. */
const MAX_PATH_BYTES = 2_048;
/** Mirrors `packages/pipeline/src/runnerState.ts`'s `MAX_IDENTITY_BINDINGS`. */
const MAX_ENTRIES = 4_096;

export type BindingsResult = {
  /** `relativePath -> externalId`, already filtered to `rootAlias`. */
  map: Map<string, string>;
  /** `map.size`: how many of the journal's bindings apply to this root and
   * were loaded into the lookup this run will consult. */
  loaded: number;
};

function invalid(path: string, reason: string): never {
  throw new Error(`Bindings file ${path} is invalid: ${reason}`);
}

function asObject(value: unknown, path: string, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, `${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(
  value: unknown,
  path: string,
  where: string,
  maxBytes: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    invalid(path, `${where} is not valid`);
  }
  return value;
}

/**
 * Finds the journal's `IdentityBinding[]`. The on-disk file is the worker's
 * full journal state (`{ version, binding, credentialSalt,
 * credentialFingerprint, credentialSessionActive, checkpoint, pending? }`,
 * `packages/pipeline/src/journal.ts`'s `parseState`); its `checkpoint` is a
 * `phase`-tagged union and only some phases (`terminal`, and the
 * `jobs_reserve`/`jobs_renew`/`jobs_stage`/`jobs_activate`/`jobs_fail`
 * family, see `RunnerCheckpoint` in `runnerState.ts`) carry a flat
 * `bindings` array -- the registry of identities the worker has resolved.
 * `missingBindings`, present on scan-phase checkpoints, is deliberately not
 * read here: those are identities the worker had *not* yet resolved, not
 * ones safe to bind a file to. A checkpoint phase with no `bindings` field
 * (for example `idle`, or mid-scan) yields zero entries, not an error --
 * that is a valid journal that simply carries no identity registry right
 * now.
 */
function findBindingEntries(parsed: unknown, path: string): unknown[] {
  const root = asObject(parsed, path, "the file");
  const checkpoint =
    "checkpoint" in root ? asObject(root.checkpoint, path, "checkpoint") : root;
  if (!("bindings" in checkpoint)) return [];
  const value = checkpoint.bindings;
  if (!Array.isArray(value)) invalid(path, "checkpoint.bindings is not an array");
  if (value.length > MAX_ENTRIES) invalid(path, "checkpoint.bindings has too many entries");
  return value;
}

/**
 * Loads and validates the old filesystem worker's identity registry from its
 * journal `state.json` (or any file holding just its `checkpoint`), opened
 * read-only -- this function never writes to `path`. Returns only the
 * entries for `rootAlias`, as a `relativePath -> externalId` map. Throws with
 * a message naming `path` if the file cannot be read, is not JSON, or its
 * bindings do not validate the way
 * `packages/pipeline/src/runnerState.ts`'s own journal codec would: a
 * non-UUID `externalId`, a duplicate path, or a duplicate `externalId`
 * anywhere in the file (not just within `rootAlias`, since an `externalId`
 * is a global `kith.source_items.external_id` candidate) each fail the run
 * rather than silently contributing a wrong or ambiguous identity.
 */
export async function loadBindings(path: string, rootAlias: string): Promise<BindingsResult> {
  if (!ROOT_ALIAS_PATTERN.test(rootAlias)) {
    throw new Error(`--root-alias "${rootAlias}" is not a valid root alias`);
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read bindings file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(path, "not valid JSON");
  }
  const entries = findBindingEntries(parsed, path);

  const paths = new Set<string>();
  const externalIds = new Set<string>();
  const map = new Map<string, string>();

  for (const raw of entries) {
    const row = asObject(raw, path, "a binding entry");
    const allowed = new Set(["rootAlias", "relativePath", "externalId", "providerFileId"]);
    const required = ["rootAlias", "relativePath", "externalId"];
    if (
      required.some((key) => !(key in row)) ||
      Object.keys(row).some((key) => !allowed.has(key))
    ) {
      invalid(path, "a binding entry has an unexpected shape");
    }
    const entryRootAlias = asString(row.rootAlias, path, "a binding's rootAlias", 64, ROOT_ALIAS_PATTERN);
    const relativePath = asString(row.relativePath, path, "a binding's relativePath", MAX_PATH_BYTES);
    const externalId = asString(row.externalId, path, "a binding's externalId", 36, UUID_PATTERN);
    if (row.providerFileId !== undefined) {
      asString(row.providerFileId, path, "a binding's providerFileId", 256, PROVIDER_FILE_ID_PATTERN);
    }
    const key = `${entryRootAlias}\0${relativePath}`;
    if (paths.has(key)) {
      invalid(path, `duplicate binding for path "${relativePath}" under root "${entryRootAlias}"`);
    }
    paths.add(key);
    if (externalIds.has(externalId)) {
      invalid(path, `duplicate externalId "${externalId}"`);
    }
    externalIds.add(externalId);
    if (entryRootAlias === rootAlias) {
      map.set(relativePath, externalId);
    }
  }

  return { map, loaded: map.size };
}
