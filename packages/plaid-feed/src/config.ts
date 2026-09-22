// Where every credential and setting this package needs comes from: an env
// override first, a Keychain item second, matching the rest of the household
// stack (docs/worker-service.md's deferred-work daemon reads
// `KITH_STORE_DATABASE_URL` from a wrapper-exported env var the same way).
//
// Nothing here defaults a connection string or a secret. `PLAID_ENV`
// defaults to `production` because the owner's Plaid plan is Trial, which
// only runs against Plaid's production environment.

import { readKeychainSecretByService } from "./keychain.js";

export const PLAID_CLIENT_ID_SERVICE = "com.kithmind.plaid.client-id";
export const PLAID_SECRET_SERVICE = "com.kithmind.plaid.secret";
export const DATABASE_URL_SERVICE = "com.kithmind.deferred-work.database-url";

export type PlaidCredentials = {
  clientId: string;
  secret: string;
  env: string;
};

async function requireSecret(
  envVar: string,
  service: string,
): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromKeychain = await readKeychainSecretByService(service);
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  throw new Error(
    `${envVar} is not set and Keychain item "${service}" was not found. ` +
      `Set ${envVar} or add the item with: ` +
      `security add-generic-password -a "$USER" -s ${service} -w <value>`,
  );
}

/** The Plaid client id, secret and environment, env-first then Keychain. */
export async function loadPlaidCredentials(): Promise<PlaidCredentials> {
  const [clientId, secret] = await Promise.all([
    requireSecret("PLAID_CLIENT_ID", PLAID_CLIENT_ID_SERVICE),
    requireSecret("PLAID_SECRET", PLAID_SECRET_SERVICE),
  ]);
  const env = process.env.PLAID_ENV?.trim() || "production";
  return { clientId, secret, env };
}

/**
 * The Postgres connection string. `DATABASE_URL` overrides; otherwise the
 * same Keychain item name the deferred-work daemon's own wrapper script
 * exports as `KITH_STORE_DATABASE_URL` (see docs/worker-service.md,
 * "Deferred work daemon").
 */
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

/** `com.kithmind.plaid.item.<institution_slug>`, this item's Keychain service. */
export function itemKeychainService(institutionName: string): string {
  return `com.kithmind.plaid.item.${institutionSlug(institutionName)}`;
}

/** Lowercase, hyphenated, alphanumeric-only slug of an institution's name. */
export function institutionSlug(institutionName: string): string {
  const slug = institutionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "institution" : slug;
}
