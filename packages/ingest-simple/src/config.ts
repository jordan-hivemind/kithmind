// Where the database connection string comes from: an env override first, a
// Keychain item second, matching the deferred-work daemon's own wrapper
// script (`docs/worker-service.md`, "Deferred work daemon") and
// `packages/plaid-feed/src/config.ts`'s `loadDatabaseUrl`.

import { readKeychainSecretByService } from "./keychain.js";

export const DATABASE_URL_SERVICE = "com.kithmind.deferred-work.database-url";

/** The Postgres connection string. `DATABASE_URL` overrides; otherwise the
 * Keychain item the deferred-work daemon's wrapper exports as
 * `KITH_STORE_DATABASE_URL`. */
export async function loadDatabaseUrl(): Promise<string> {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromKeychain = await readKeychainSecretByService(DATABASE_URL_SERVICE);
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  throw new Error(
    `DATABASE_URL is not set and Keychain item "${DATABASE_URL_SERVICE}" ` +
      "was not found. Set DATABASE_URL or add the item with: " +
      `security add-generic-password -a "$USER" -s ${DATABASE_URL_SERVICE} -w <postgres-url>`,
  );
}
