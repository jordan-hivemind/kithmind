// A document's `kith.source_items.uri` is not just a label: `apps/web/src/lib/kith/document-content.ts`'s
// `documentDropboxPath` parses it back with `^fs:\/\/([^/]+)\/(.+)$`, matches
// the alias against `KITH_DOCUMENT_DROPBOX`'s configured roots by source
// account, and `decodeURIComponent`s the remainder one path segment at a
// time to reach the original file for retrieval. This package's own file
// identities already use that alias for `--bindings`/`--root-alias`
// (bindings.ts), and the old filesystem worker wrote this exact format
// (`packages/pipeline/src/filesystem.ts`'s `toFsUri`, which this package does
// not import -- AGENTS.md keeps a side lane out of `packages/pipeline`).
// Reimplemented faithfully here (percent-encode each path segment, same
// separator handling) so a document this package writes is retrievable
// through that path the same way one the old worker wrote is.

import { sep } from "node:path";

/** `fs://<alias>/<percent-encoded relativePath>`, or `undefined` when no
 * `rootAlias` is available (`--root-alias` was not given) -- there is no
 * resolvable URI to write without one, so the caller leaves `uri` unset
 * rather than writing an alias-less value `documentDropboxPath` could never
 * match. Throws only for a relative path that cannot become a URI at all
 * (absolute, or empty); an oversized result is still caught by
 * `@repo/kith-store`'s own `MAX_URI_BYTES` bound in `createOrGetSourceItem`/
 * `refreshAvailableSourceItem`, which this does not duplicate. Callers see
 * either failure as an ordinary per-file error, exactly like a conversion
 * error. */
export function toFsUri(alias: string, relativePath: string): string {
  if (relativePath.startsWith(sep) || relativePath.startsWith("/")) {
    throw new Error("relative path is absolute");
  }
  const parts = relativePath.split(sep).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("relative path is not a stable child of the root");
  }
  return `fs://${alias}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}
