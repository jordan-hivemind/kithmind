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
  loadClientSecretOrNull,
  personSlug,
  redirectUri,
  SANDBOX_FHIR_BASE,
  tokenKeychainService,
  type EpicEnv,
} from "./config.js";
import { resolvePerson, upsertHealthSource } from "./db.js";
import { findEndpointsByName } from "./endpoints.js";
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
import { keychainTokenStore, type TokenStore } from "./keychain.js";

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

async function resolveOrg(
  env: EpicEnv,
  org: string | undefined,
  fetchImpl: Fetch,
): Promise<{ orgName: string; fhirBase: string }> {
  if (env === "sandbox") {
    return { orgName: org ?? "Epic Sandbox", fhirBase: SANDBOX_FHIR_BASE };
  }
  if (org === undefined || org.trim() === "") {
    throw new Error("--org \"<health system name>\" is required in production");
  }
  const matches = await findEndpointsByName(org, fetchImpl);
  if (matches.length === 0) {
    throw new Error(`No health system in Epic's endpoint directory matches "${org}"`);
  }
  if (matches.length > 1) {
    const names = matches
      .slice(0, 20)
      .map((match) => `  - ${match.orgName}`)
      .join("\n");
    throw new Error(
      `"${org}" matches more than one health system; use a more specific name:\n${names}`,
    );
  }
  return matches[0]!;
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
  } = deps;

  const person = await resolvePerson(pool, args.personSelector);
  if (person === null) {
    throw new Error(`No person found for "${args.personSelector}"`);
  }

  const env: EpicEnv = args.sandbox ? "sandbox" : epicEnv();
  const { orgName, fhirBase } = await resolveOrg(env, args.org, fetchImpl);
  const [clientId, clientSecret] = await Promise.all([
    loadClientId(env),
    loadClientSecretOrNull(),
  ]);
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

  const keychainService = tokenKeychainService(personSlug(person.canonicalName));
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
