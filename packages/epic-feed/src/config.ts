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

/** The client secret: `EPIC_CLIENT_SECRET` first, then Keychain. Never a
 * built-in default -- the secret is never a public value. */
export async function loadClientSecret(): Promise<string> {
  const fromEnv = process.env.EPIC_CLIENT_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromKeychain = await readKeychainSecretByService(
    EPIC_CLIENT_SECRET_SERVICE,
  );
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
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

/** Lowercase, hyphenated, alphanumeric-only slug of a person's name, the
 * same shape `@repo/plaid-feed`'s `institutionSlug` produces. */
export function personSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "person" : slug;
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
