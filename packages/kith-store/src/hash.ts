import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256.
 *
 * Its own module rather than a function in `index.ts` so the identity surface can
 * use the package's one hash without importing the package's entry point back
 * into itself. `index.ts` re-exports it, so every existing caller is unaffected.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
