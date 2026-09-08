// Connecting to the hosted archive, and pinning how the driver decodes it.
//
// node-postgres decodes result columns by PostgreSQL type OID. Its current
// default for NUMERIC is already "hand back the text", which is correct, and
// that is exactly why it is pinned here rather than relied on: a default is a
// choice someone else can change in a minor release, and a driver that
// silently started returning a float for NUMERIC would reintroduce the
// failure the type was chosen to prevent, quietly and everywhere at once.
// `test/pgNumeric.test.mjs` asserts the pin, with no database required.
//
// INT8 is pinned for the same reason: counts and sums of counts cross 2^53.

import pg from "pg";

/** Type OIDs whose decoding this package refuses to leave to a default. */
export const PINNED_TEXT_OIDS: readonly number[] = Object.freeze([
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
]);

/** Hands the wire text back untouched. Never `parseFloat`, never `Number`. */
const decodeAsText = (value: string): string => value;

/**
 * Installs the pinned decoders. Idempotent, and called at module load so
 * importing this package is enough; exported so a test can assert the pin
 * rather than trust it.
 */
export function pinNumericDecoding(): void {
  for (const oid of PINNED_TEXT_OIDS) {
    pg.types.setTypeParser(oid, decodeAsText);
  }
}

pinNumericDecoding();

/** True when the driver would hand this OID back as text, unparsed. */
export function decodesAsText(oid: number): boolean {
  return pg.types.getTypeParser(oid) === decodeAsText;
}

/**
 * The connection string, from the environment and nowhere else. There is no
 * default, the same rule `FINANCE_ARCHIVE_DB_PATH` and
 * `FINANCE_ARCHIVE_RAW_TREE_ROOT` already follow: a missing setting is a hard
 * error that names what is missing. A connection string never enters this
 * repository, and a guessed default would let a misconfigured client open
 * whatever database happens to answer.
 */
export function archiveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.FINANCE_ARCHIVE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FINANCE_ARCHIVE_DATABASE_URL is not set. Point it at the archive database; " +
        "that connection string is never committed and this package never defaults to one.",
    );
  }
  return url;
}

/** A pool against the archive, with decoding pinned before the first query. */
export function createArchivePool(url: string = archiveDatabaseUrl()): pg.Pool {
  pinNumericDecoding();
  return new pg.Pool({ connectionString: url });
}
