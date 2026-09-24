// Where every credential and setting this package needs comes from: an env
// override first, a Keychain item second, the same convention
// `@repo/plaid-feed`'s own `config.ts` documents and
// `docs/onboarding.md`'s Epic section assumes for the client id and secret.
//
// Nothing here defaults a connection string or a secret; it only defaults
// which *client id* to use per environment, because those two ids are public
// values named directly in the task that authorized this package (client IDs
// are not secrets -- Epic's own app registration page shows them in the
// clear), not something this package invents.

import { readKeychainSecretByService } from "./keychain.js";

export const EPIC_CLIENT_ID_SERVICE = "com.kithmind.epic.client-id";
export const EPIC_CLIENT_ID_NONPROD_SERVICE =
  "com.kithmind.epic.client-id-nonprod";
export const EPIC_CLIENT_SECRET_SERVICE = "com.kithmind.epic.client-secret";
/** Same Keychain item `@repo/plaid-feed` reads, matching the task's
 * instruction that the database URL is resolved "as plaid-feed does it". */
export const DATABASE_URL_SERVICE = "com.kithmind.deferred-work.database-url";

/** Epic's own non-production (sandbox) client id, a public value from the
 * app's fhir.epic.com registration. */
export const SANDBOX_CLIENT_ID = "9860f2e0-b9c5-4c42-8bdf-8a04cdf9852d";
/** Epic's own production client id, a public value from the app's
 * fhir.epic.com registration. */
export const PRODUCTION_CLIENT_ID = "59762e7c-760c-4cbe-89d8-3bfd8906d828";

export const SANDBOX_FHIR_BASE =
  "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/";
export const PRODUCTION_ENDPOINT_DIRECTORY_URL =
  "https://open.epic.com/Endpoints/R4";

export const REDIRECT_URI_PRODUCTION =
  "https://brain.hive-mind.com/api/epic/callback";
// Epic's sandbox rejected the http://localhost redirect in practice
// (OAuth/Start error=4) while accepting the https callback page, so both
// environments use the hosted page. EPIC_REDIRECT_URI overrides either.
export const REDIRECT_URI_SANDBOX = REDIRECT_URI_PRODUCTION;

export type EpicEnv = "sandbox" | "production";

/** The R4 resources this package's incoming APIs cover, in the order the
 * task lists them. Every one gets a `patient/<Resource>.read` v1 scope;
 * `Patient` is fetched by id and the rest (other than `Binary`, fetched only
 * as a `DocumentReference` attachment) are searched by patient. */
export const FHIR_RESOURCES = [
  "Patient",
  "Observation",
  "DiagnosticReport",
  "Condition",
  "MedicationRequest",
  "AllergyIntolerance",
  "Immunization",
  "Encounter",
  "Procedure",
  "DocumentReference",
  "Binary",
  "Specimen",
  "Goal",
] as const;

export type FhirResource = (typeof FHIR_RESOURCES)[number];

/** The resources `pull` pages through with `_count=200` and `patient=` --
 * every incoming resource except `Patient` (read by id, not searched) and
 * `Binary` (fetched only as a `DocumentReference` attachment). */
export const SEARCHABLE_RESOURCES = FHIR_RESOURCES.filter(
  (resource) => resource !== "Patient" && resource !== "Binary",
);

/** Epic rejects an `Observation` search with no `category` parameter (400).
 * These are the three categories this app registered scopes for; `pull`
 * searches once per category and merges the pages under one `Observation`
 * count, keeping each stored record's own `category` (from the resource
 * itself, not the search parameter). */
export const OBSERVATION_SEARCH_CATEGORIES = [
  "laboratory",
  "vital-signs",
  "social-history",
] as const;

/** Resource types where Epic's sandbox has been observed to reject the
 * search outright (400) for a source that simply doesn't support that
 * resource type. `pull` treats this as "unsupported for that source" rather
 * than a resource error: skipped, counted under `unsupported`, source status
 * unaffected, not retried within the same run. */
export const UNSUPPORTED_ON_400_RESOURCES = new Set<string>(["Specimen", "Goal"]);

/** `EPIC_ENV`, defaulting to production per the task. */
export function epicEnv(): EpicEnv {
  const raw = process.env.EPIC_ENV?.trim().toLowerCase();
  if (raw === "sandbox") return "sandbox";
  if (raw === "production" || raw === undefined || raw === "") {
    return "production";
  }
  throw new Error(`EPIC_ENV must be "sandbox" or "production", got "${raw}"`);
}

/**
 * The client id: `EPIC_CLIENT_ID` first, then the environment's own Keychain
 * item, then the well-known public default id for that environment.
 */
export async function loadClientId(env: EpicEnv): Promise<string> {
  const fromEnv = process.env.EPIC_CLIENT_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const service =
    env === "sandbox"
      ? EPIC_CLIENT_ID_NONPROD_SERVICE
      : EPIC_CLIENT_ID_SERVICE;
  const fromKeychain = await readKeychainSecretByService(service);
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  return env === "sandbox" ? SANDBOX_CLIENT_ID : PRODUCTION_CLIENT_ID;
}

/**
 * The client secret: `EPIC_CLIENT_SECRET` first, then Keychain, `null` when
 * neither is configured. A missing secret is not an error here -- Epic's
 * sandbox has been observed to treat this app's registration as a public
 * client regardless of the secret, so `oauth.ts`'s token exchange and
 * refresh fall back to the public-client method instead of failing.
 */
export async function loadClientSecretOrNull(): Promise<string | null> {
  const fromEnv = process.env.EPIC_CLIENT_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromKeychain = await readKeychainSecretByService(
    EPIC_CLIENT_SECRET_SERVICE,
  );
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  return null;
}

/** `com.kithmind.epic.client-secret.<org-slug>`, one organization's own
 * client secret item -- see `loadClientSecretForOrg`. */
export function clientSecretKeychainService(orgName: string): string {
  return `${EPIC_CLIENT_SECRET_SERVICE}.${orgSlug(orgName)}`;
}

export type ClientSecretLookup = {
  secret: string | null;
  /** The Keychain item name or env var name the secret came from, or
   * `"none"` when nothing is configured. Never the secret value -- this is
   * what `authorize` reports. */
  source: string;
};

/**
 * The client secret for one organization: Epic issues a refresh token only
 * when a client secret is configured for that organization ("select the key
 * icon next to the organization... if you forgo adding client secrets,
 * refresh tokens will be unavailable for that organization"), and Epic
 * recommends a distinct secret per organization and per environment. So the
 * lookup is per-org first: that organization's own Keychain item
 * (`clientSecretKeychainService`), then the shared Keychain item
 * (`EPIC_CLIENT_SECRET_SERVICE`), then `EPIC_CLIENT_SECRET`. `secret: null`
 * when none of the three is configured -- not an error, since a missing
 * secret falls back to the public-client method (see
 * `loadClientSecretOrNull`) rather than failing.
 *
 * `readSecret` defaults to the real Keychain and is overridden by a test
 * with an in-memory reader.
 */
export async function loadClientSecretForOrg(
  orgName: string,
  readSecret: (service: string) => Promise<string | null> = readKeychainSecretByService,
): Promise<ClientSecretLookup> {
  const perOrgService = clientSecretKeychainService(orgName);
  const fromPerOrg = await readSecret(perOrgService);
  if (fromPerOrg !== null && fromPerOrg !== "") {
    return { secret: fromPerOrg, source: perOrgService };
  }
  const fromShared = await readSecret(EPIC_CLIENT_SECRET_SERVICE);
  if (fromShared !== null && fromShared !== "") {
    return { secret: fromShared, source: EPIC_CLIENT_SECRET_SERVICE };
  }
  const fromEnv = process.env.EPIC_CLIENT_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { secret: fromEnv, source: "EPIC_CLIENT_SECRET" };
  }
  return { secret: null, source: "none" };
}

/** Same as `loadClientSecretOrNull`, but throws when neither `EPIC_CLIENT_SECRET`
 * nor the Keychain item is configured. Kept for callers that genuinely
 * require a confidential-client secret; `authorize`/`pull`'s token calls use
 * `loadClientSecretOrNull` instead so a public-client registration works
 * with no secret configured at all. */
export async function loadClientSecret(): Promise<string> {
  const secret = await loadClientSecretOrNull();
  if (secret !== null) return secret;
  throw new Error(
    `EPIC_CLIENT_SECRET is not set and Keychain item "${EPIC_CLIENT_SECRET_SERVICE}" ` +
      "was not found. Set EPIC_CLIENT_SECRET or add the item with: " +
      `security add-generic-password -a "$USER" -s ${EPIC_CLIENT_SECRET_SERVICE} -w <value>`,
  );
}

/**
 * The Postgres connection string. `DATABASE_URL` overrides; otherwise the
 * same Keychain item `@repo/plaid-feed` reads (see `DATABASE_URL_SERVICE`
 * above).
 */
export async function loadDatabaseUrl(): Promise<string> {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromKeychain = await readKeychainSecretByService(DATABASE_URL_SERVICE);
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  throw new Error(
    "DATABASE_URL is not set and Keychain item " +
      `"${DATABASE_URL_SERVICE}" was not found. Set DATABASE_URL or add the ` +
      `item with: security add-generic-password -a "$USER" -s ${DATABASE_URL_SERVICE} -w <postgres-url>`,
  );
}

/** `com.kithmind.epic.token.<person-slug>`, the Keychain item `authorize`
 * writes and `pull` reads for one person's tokens. */
export function tokenKeychainService(personSlug: string): string {
  return `com.kithmind.epic.token.${personSlug}`;
}

/** Lowercase, hyphenated, alphanumeric-only slug, the same shape
 * `@repo/plaid-feed`'s `institutionSlug` produces; falls back to `fallback`
 * when nothing alphanumeric remains. */
function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/** Lowercase, hyphenated, alphanumeric-only slug of a person's name. */
export function personSlug(name: string): string {
  return slugify(name, "person");
}

/** Lowercase, hyphenated, alphanumeric-only slug of a health system's name,
 * e.g. `"Virginia Mason Franciscan Health"` -> `"virginia-mason-franciscan-health"`.
 * Used only for `clientSecretKeychainService`. */
export function orgSlug(orgName: string): string {
  return slugify(orgName, "org");
}

/** The redirect URI this environment's app registration uses. */
export function redirectUri(env: EpicEnv): string {
  const override = process.env.EPIC_REDIRECT_URI?.trim();
  if (override) return override;
  return env === "sandbox" ? REDIRECT_URI_SANDBOX : REDIRECT_URI_PRODUCTION;
}

/** The base data directory PDFs (and any other binary Clinical Notes
 * attachment) are stored under, one subfolder per person. */
export function healthDataDir(personSlugValue: string): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set; cannot resolve the data directory");
  return `${home}/.local/share/kithmind/health/${personSlugValue}`;
}
