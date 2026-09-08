// F1-23: the credential-free projection applied to every acquired payload
// before its bytes are hashed or written.
// (docs/plans/2026-09-07-financial-transaction-database.md, ground rule 4 and
// the F1-23 row: "A closed allowlisted projection of the business payload
// happens before hashing or writing, and a sanitized artifact records the
// transformation rather than claiming to be the untouched response.")
//
// The hole this closes: the *input* side of ground rule 4 was already shut --
// `AdapterSession` is two async functions and nothing else, so an adapter has
// nowhere to put a header, a cookie or a token. The *output* side was wide
// open. A provider's JSON activity response can echo back a session token, an
// `Authorization` header, a `Set-Cookie` value, a refresh token, a device id
// or a whole user profile alongside the transactions, and the raw tree is a
// synced folder. Nothing inspected those bytes on their way to disk.
//
// Four properties, in the order they matter:
//
// 1. Allowlist, never denylist. The projection is *built up* from an
//    adapter's declaration, never *stripped down* from the provider's
//    response. A field the provider adds next month is not copied, because
//    nothing copies a field that was not named. There is no pattern of
//    credential-looking key names anywhere in this file, deliberately: a
//    denylist fails open exactly once and that is enough.
// 2. Hash what you actually retain. `retainPayload` is the only thing that
//    produces bytes for the raw tree, and it hashes the bytes it produced.
//    The original response is never hashed and never stored; a projected
//    artifact is never normalized back toward the original so that two
//    hashes agree. The content hash is always the hash of the bytes on disk.
// 3. Record the transformation. `RetentionRecord` travels with the bytes into
//    the raw tree's manifest sidecar, so a reader who opens a retained file
//    years later learns that it is a projection, which declaration produced
//    it, which projection algorithm version applied it, and which source
//    paths were dropped.
// 4. It has to be impossible, not discouraged. `RetainedPayload` is branded
//    at compile time and tracked in a module-private WeakSet at run time, and
//    `writeRawDocument` accepts nothing else. There is no way to hand raw
//    provider bytes to the raw tree writer, the same way F1-18 made
//    `AdapterPull.persisted` impossible to invent.
//
// Money keeps its exact digits across the projection. Every JSON primitive is
// captured as its own literal source text (`JSON.parse`'s reviver `context`,
// Node 22+) and re-emitted through `JSON.rawJSON`, so a provider that states
// an amount as a JSON number with more precision than a double can hold is
// retained with that precision intact rather than silently rounded. The money
// policy says binary floating point appears nowhere in the path; this keeps
// that true through the one place that re-serializes a payload.

import { createHash } from "node:crypto";

import type { CapabilityTier } from "./adapter.js";

/** `JSON.rawJSON` / `JSON.isRawJSON` (Node 22+, and this repo requires Node
 * 24) are not in the shared `es2022` lib this package compiles against, and
 * widening that lib for every package is not this task's business. A local
 * typed view of the two globals, used nowhere else. */
type RawJson = { readonly rawJSON: string };
const rawJson = JSON as unknown as {
  rawJSON(text: string): RawJson;
  isRawJSON(value: unknown): value is RawJson;
};

/** Bumped when the projection algorithm itself changes shape, independently
 * of any adapter's declaration. Recorded on every retained artifact. */
export const PROJECTION_VERSION = "1";

/**
 * What one adapter declares it retains from one kind of payload.
 *
 * `json_allowlist` names the exact leaf paths kept from a JSON payload.
 * Segments are dot-separated; `*` matches any array index or any object key.
 * A path must terminate on a scalar: `"pages.*.items.*.amount"` is a
 * declaration, `"pages.*.items"` is not, because retaining an object whose
 * fields were never named is the pass-through this whole file exists to
 * prevent.
 *
 * `opaque` retains the bytes whole, unprojected. This is the honest answer
 * for an artifact that has no addressable fields: a PDF statement is a
 * rendered document, and a tabular export is a file the site generated for a
 * person to open. Neither can be field-projected, so the declaration says so
 * out loud, the manifest records `opaque`, and no reader mistakes the result
 * for a filtered payload. It is refused outright for `structured_api`
 * (`retainPayload` below): a JSON response is exactly the shape that echoes
 * session state back, so "opaque" must never become a one-word way to opt out
 * of the allowlist for the tier that needs it most.
 */
export type RetentionPolicy =
  | {
      readonly kind: "json_allowlist";
      /** The adapter's own version for this declaration. Changing what is
       * retained changes this, so two artifacts are comparable. */
      readonly version: string;
      readonly fields: readonly string[];
    }
  | {
      readonly kind: "opaque";
      readonly version: string;
      /** Why this artifact cannot be field-projected. Required, non-empty. */
      readonly note: string;
    };

/**
 * What was actually done to one payload, persisted into the raw tree's
 * manifest sidecar. `droppedPaths` names source paths only -- never values --
 * so the record is safe to keep next to the bytes and safe to read.
 */
export type RetentionRecord = {
  readonly policy: RetentionPolicy;
  readonly projectionVersion: string;
  /** Source paths present in the payload that the declaration did not name,
   * with `*` standing in for array indices so a thousand-row response
   * reports one path rather than a thousand. Sorted, deduplicated. Empty for
   * an `opaque` retention, which drops nothing by definition. */
  readonly droppedPaths: readonly string[];
};

/** A payload's shape contradicts the declaration in a way that cannot be
 * resolved by dropping a field: a declared path ends above a nested value, an
 * array is described without `*`, or a JSON allowlist was declared for bytes
 * that are not JSON. This is an adapter bug, so it stops the acquisition
 * rather than opening a review item. Never carries a payload value. */
export class RetentionShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionShapeError";
  }
}

declare const RETAINED_BRAND: unique symbol;

/**
 * Bytes that have been through the projection, together with the hash of
 * those same bytes and the record of how they were produced. `retainPayload`
 * is the only producer; the raw tree writer accepts nothing else.
 */
export type RetainedPayload = {
  readonly [RETAINED_BRAND]: true;
  readonly bytes: Uint8Array;
  /** sha256 of `bytes` -- the retained bytes, which are the bytes on disk. */
  readonly sha256: string;
  readonly record: RetentionRecord;
};

// Run-time half of the brand. A compile-time brand alone is a type assertion
// away from being defeated, and this is the boundary the whole task is about.
const produced = new WeakSet<object>();

/** Throws unless `value` came out of `retainPayload`. */
export function assertRetained(value: RetainedPayload): RetainedPayload {
  if (typeof value !== "object" || value === null || !produced.has(value)) {
    throw new TypeError(
      "expected a RetainedPayload produced by retainPayload(); raw provider bytes " +
        "cannot be written to the raw tree (F1-23, ground rule 4)",
    );
  }
  return value;
}

// --- the allowlist trie -----------------------------------------------------

type TrieNode = {
  /** null marks a declared leaf: a scalar is retained here and nothing deeper. */
  children: Map<string, TrieNode> | null;
};

function buildTrie(fields: readonly string[]): TrieNode {
  if (fields.length === 0) {
    throw new RetentionShapeError(
      "a json_allowlist retention declares no fields; a declaration that retains " +
        "nothing is a bug, not a policy",
    );
  }
  const root: TrieNode = { children: new Map() };
  for (const field of fields) {
    const segments = field.split(".");
    if (segments.some((segment) => segment === "")) {
      throw new RetentionShapeError(`malformed retention field path: ${JSON.stringify(field)}`);
    }
    let node: TrieNode = root;
    for (const [depth, segment] of segments.entries()) {
      if (node.children === null) {
        throw new RetentionShapeError(
          `retention field path ${JSON.stringify(field)} descends through ` +
            `${JSON.stringify(segments.slice(0, depth).join("."))}, which another ` +
            "declared path already terminates on as a scalar",
        );
      }
      const last = depth === segments.length - 1;
      const existing = node.children.get(segment);
      if (existing) {
        if (last && existing.children !== null) {
          throw new RetentionShapeError(
            `retention field path ${JSON.stringify(field)} is declared as a scalar but ` +
              "another declared path descends through it",
          );
        }
        node = existing;
      } else {
        const created = { children: last ? null : new Map<string, TrieNode>() };
        node.children.set(segment, created);
        node = created;
      }
    }
  }
  return root;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null && !rawJson.isRawJSON(value);
}

/**
 * Builds the retained value out of the declaration. This walks the source and
 * copies only what the trie names, so the output is constructed rather than
 * filtered: there is no branch in which an undeclared key is carried forward.
 */
function project(
  value: unknown,
  node: TrieNode,
  path: readonly string[],
  dropped: Set<string>,
): unknown {
  const here = path.join(".") || "(root)";

  if (node.children === null) {
    if (isContainer(value)) {
      throw new RetentionShapeError(
        `retention declaration terminates at ${JSON.stringify(here)} but the payload ` +
          "holds a nested value there; name the fields inside it or the projection " +
          "would retain material nobody declared",
      );
    }
    return value;
  }

  // A declared subtree the provider states as `null` is a legitimately absent
  // section, not a shape violation. (Every JSON primitive, `null` included,
  // arrives here wrapped by JSON.rawJSON, so this is the only null check.)
  if (!isContainer(value)) {
    if (rawJson.isRawJSON(value) && value.rawJSON === "null") {
      return value;
    }
    throw new RetentionShapeError(
      `retention declaration names fields under ${JSON.stringify(here)} but the payload ` +
        "holds a scalar there",
    );
  }

  if (Array.isArray(value)) {
    const wildcard = node.children.get("*");
    if (!wildcard) {
      throw new RetentionShapeError(
        `the payload holds an array at ${JSON.stringify(here)} but the retention ` +
          'declaration names no "*" element there',
      );
    }
    return value.map((element) => project(element, wildcard, [...path, "*"], dropped));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = node.children.get(key) ?? node.children.get("*");
    if (!child) {
      dropped.add([...path, key].join("."));
      continue;
    }
    out[key] = project(value[key], child, [...path, key], dropped);
  }
  return out;
}

/** Captures every JSON primitive as its own literal source text, so the
 * projection re-emits the provider's exact digits rather than a double's
 * shortest round-trip of them. */
function rawPrimitiveReviver(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  return context?.source === undefined ? value : rawJson.rawJSON(context.source);
}

function make(bytes: Uint8Array, record: RetentionRecord): RetainedPayload {
  const payload = Object.freeze({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    record,
  }) as unknown as RetainedPayload;
  produced.add(payload);
  return payload;
}

/**
 * Applies `policy` to `sourceBytes` and returns the retained artifact: the
 * projected bytes, the hash *of those bytes*, and the record of what was
 * done. This is the only way to produce bytes the raw tree will accept.
 *
 * `tier` is the capability tier the payload came from, and it is what stops
 * `opaque` being used as an escape hatch on the tier that needs the allowlist
 * most: a `structured_api` response is refused unless it declares fields.
 *
 * Idempotent for `json_allowlist`: projecting an already-projected payload
 * produces byte-identical output and drops nothing. That is what lets the
 * persistence seam re-apply the projection as a guarantee rather than a
 * duplicate transformation, and it is why an adapter that hashed the wrong
 * bytes is caught there instead of quietly writing them.
 *
 * No error message in this file ever contains a payload value. Paths, types
 * and counts only: a leak report that prints the leak is not a fix.
 */
export function retainPayload(
  policy: RetentionPolicy,
  sourceBytes: Uint8Array,
  tier: CapabilityTier,
): RetainedPayload {
  if (policy.kind === "opaque") {
    if (tier === "structured_api") {
      throw new RetentionShapeError(
        "a structured_api payload may not be retained opaque: a JSON response is " +
          "exactly the shape that echoes session state back alongside the business " +
          "payload, so it must declare the fields it retains (ground rule 4)",
      );
    }
    if (policy.note.trim() === "") {
      throw new RetentionShapeError(
        "an opaque retention must state why the artifact cannot be field-projected",
      );
    }
    return make(sourceBytes, {
      policy,
      projectionVersion: PROJECTION_VERSION,
      droppedPaths: [],
    });
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    parsed = (JSON.parse as (text: string, reviver: unknown) => unknown)(
      text,
      rawPrimitiveReviver,
    );
  } catch {
    throw new RetentionShapeError(
      "a json_allowlist retention was declared but the payload is not valid UTF-8 JSON; " +
        "declare an opaque retention for an artifact that has no addressable fields",
    );
  }

  const dropped = new Set<string>();
  const projected = project(parsed, buildTrie(policy.fields), [], dropped);
  return make(new TextEncoder().encode(JSON.stringify(projected)), {
    policy,
    projectionVersion: PROJECTION_VERSION,
    droppedPaths: [...dropped].sort(),
  });
}
