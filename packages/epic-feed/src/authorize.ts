// `kith-epic-feed authorize --person <id-or-name> [--org "<health system>"]
// [--sandbox]`: one SMART standalone launch with PKCE, ending in a Keychain
// item and a `kith.health_sources` row for that person.
//
// One authorization per person, done through the account holder's own proxy
// access for a family member (Epic's own MyChart mechanism, not anything
// this package implements) -- this command only ever asks Epic to
// authorize a single patient context per run.

import type { Pool } from "pg";

import {
  epicEnv,
  FHIR_RESOURCES,
  loadClientId,
  loadClientSecretForOrg,
  personSlug,
  redirectUri,
  tokenKeychainService,
  type EpicEnv,
} from "./config.js";
import { findHealthSourceByPatient, resolvePerson, upsertHealthSource } from "./db.js";
import { resolveOrgForEnv } from "./endpoints.js";
import {
  buildAuthorizationUrl,
  codeChallengeS256,
  discoverSmartConfiguration,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  parsePastedCode,
  type Fetch,
} from "./oauth.js";
import {
  keychainTokenStore,
  readKeychainSecretByService,
  type TokenStore,
} from "./keychain.js";

export type AuthorizeArgs = {
  personSelector: string;
  org?: string;
  sandbox: boolean;
};

export type AuthorizeDeps = {
  pool: Pool;
  fetchImpl?: Fetch;
  /** Reads the pasted code (or full callback URL) from the operator. */
  prompt?: (question: string) => Promise<string>;
  /** Where the person's tokens are stored. Defaults to the real Keychain; a
   * test passes an in-memory store instead. */
  tokenStore?: TokenStore;
  report?: (line: string) => void;
  generateVerifier?: () => string;
  generateStateValue?: () => string;
  /** Reads one Keychain item by service name, for `loadClientSecretForOrg`.
   * Defaults to the real Keychain; a test passes an in-memory reader instead
   * (`security` does not exist on a Linux CI runner). */
  readClientSecret?: (service: string) => Promise<string | null>;
};

export type AuthorizeOutcome = {
  status: "linked";
  orgName: string;
  personName: string;
  fhirBase: string;
};

/** The SMART v1 scopes this package always requests: the launch scopes plus
 * one `patient/<Resource>.read` per incoming resource (v1 form: no `.v1`
 * suffix, no `system/` scopes). */
export function requiredScopes(): string[] {
  return [
    "openid",
    "fhirUser",
    "offline_access",
    "launch/patient",
    ...FHIR_RESOURCES.map((resource) => `patient/${resource}.read`),
  ];
}

/** One standalone SMART launch: builds the authorization URL, exchanges the
 * pasted code, and stores the result. Every dependency is injectable so a
 * test drives this with no network, no Keychain and no real stdin. */
export async function runAuthorize(
  args: AuthorizeArgs,
  deps: AuthorizeDeps,
): Promise<AuthorizeOutcome> {
  const {
    pool,
    fetchImpl = fetch,
    prompt = defaultPrompt,
    tokenStore = keychainTokenStore,
    report = (line) => process.stdout.write(`${line}\n`),
    generateVerifier = generateCodeVerifier,
    generateStateValue = generateState,
    readClientSecret = readKeychainSecretByService,
  } = deps;

  const person = await resolvePerson(pool, args.personSelector);
  if (person === null) {
    throw new Error(`No person found for "${args.personSelector}"`);
  }

  const env: EpicEnv = args.sandbox ? "sandbox" : epicEnv();
  const { orgName, fhirBase } = await resolveOrgForEnv(env, args.org, fetchImpl);
  const clientId = await loadClientId(env);
  const secretLookup = await loadClientSecretForOrg(orgName, readClientSecret);
  const clientSecret = secretLookup.secret;
  report(`Client secret: ${secretLookup.source}`);
  const discovery = await discoverSmartConfiguration(fhirBase, fetchImpl);

  const codeVerifier = generateVerifier();
  const codeChallenge = codeChallengeS256(codeVerifier);
  const state = generateStateValue();
  const uri = redirectUri(env);
  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: discovery.authorizationEndpoint,
    clientId,
    redirectUri: uri,
    scopes: requiredScopes(),
    state,
    codeChallenge,
    aud: fhirBase,
  });

  report(`Authorizing ${person.canonicalName} against ${orgName}.`);
  report("Open this URL, sign in, and approve access:");
  report(authorizationUrl);
  const pasted = await prompt("Paste the code shown by the callback page:");
  const { code } = parsePastedCode(pasted, state);

  const token = await exchangeCode(
    {
      tokenEndpoint: discovery.tokenEndpoint,
      clientId,
      clientSecret,
      code,
      redirectUri: uri,
      codeVerifier,
    },
    fetchImpl,
  );
  if (token.patientFhirId === null) {
    throw new Error("Epic's token response had no patient id (launch/patient scope)");
  }

  // Guard against the operator picking the wrong family member in MyChart's
  // proxy picker: if some other person entity is already linked to this
  // exact patient at this org, refuse before anything is written -- the
  // token store and `kith.health_sources` are untouched below this point.
  // Re-authorizing the same person for the same patient (a normal refresh
  // or re-link) is unaffected.
  const collision = await findHealthSourceByPatient(
    pool,
    fhirBase,
    token.patientFhirId,
    person.id,
  );
  if (collision !== null) {
    throw new Error(
      `The patient picked for "${args.personSelector}" at ${orgName} is already linked to ` +
        `another person in Kith Mind. Re-run "authorize" and choose the intended family ` +
        `member in MyChart's proxy picker.`,
    );
  }

  report(
    `Authorized as ${token.clientAuth === "public" ? "public" : "confidential"} ` +
      `client; refresh token: ${token.refreshToken !== null ? "present" : "absent"}`,
  );
  if (token.refreshToken === null) {
    report(
      "No refresh token was returned; the daily pull will need a new " +
        "authorization once this access token expires.",
    );
  }

  const keychainService = tokenKeychainService(personSlug(person.canonicalName), orgName);
  await tokenStore.set(
    keychainService,
    JSON.stringify({
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      patientFhirId: token.patientFhirId,
      fhirBase,
      orgName,
      clientAuth: token.clientAuth,
    }),
  );

  await upsertHealthSource(pool, {
    personId: person.id,
    spaceId: person.spaceId,
    orgName,
    fhirBase,
    patientFhirId: token.patientFhirId,
    keychainService,
    scopes: token.scope ?? requiredScopes().join(" "),
  });

  report(`Linked ${orgName} for ${person.canonicalName}.`);
  return { status: "linked", orgName, personName: person.canonicalName, fhirBase };
}

async function defaultPrompt(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question} `);
  } finally {
    rl.close();
  }
}
