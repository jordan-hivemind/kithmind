// `kith-epic-feed check [--org "<health system>"] [--sandbox]`: diagnoses
// whether an Epic organization has picked up this app's client ID, and
// whether its per-organization client secret is configured correctly --
// without ever opening a browser, touching the database, or writing a
// Keychain token item, so it is safe to run before (and instead of) trying
// a real `authorize` and getting stuck on an ambiguous `invalid_client`.
//
// The technique: send a token request with a deliberately bogus
// authorization code. Epic rejects it either way, but *which* error it
// returns is diagnostic. `invalid_grant` means the token endpoint accepted
// the client (it got far enough to reject the code itself); `invalid_client`
// means it rejected the client before ever looking at the code. Doing this
// once with the configured client secret (HTTP Basic) and once with no
// secret at all -- the same two shapes `oauth.ts`'s `exchangeCode` tries
// during a real authorization, but run independently here instead of one
// falling back to the other -- distinguishes "this organization doesn't
// know the client ID yet" from "it knows the client ID but the secret is
// wrong".

import {
  epicEnv,
  loadClientIdWithSource,
  loadClientSecretForOrg,
  redirectUri,
  type EpicEnv,
} from "./config.js";
import { resolveOrgForEnv } from "./endpoints.js";
import { readKeychainSecretByService } from "./keychain.js";
import {
  discoverSmartConfiguration,
  probeTokenRequest,
  type Fetch,
  type TokenErrorProbe,
} from "./oauth.js";

export type CheckArgs = {
  org?: string;
  sandbox: boolean;
};

export type CheckDeps = {
  fetchImpl?: Fetch;
  report?: (line: string) => void;
  /** Reads one Keychain item by service name, for both the client id and
   * the per-organization client secret lookups. Defaults to the real
   * Keychain; a test passes an in-memory reader instead (`security` does
   * not exist on a Linux CI runner). */
  readKeychainItem?: (service: string) => Promise<string | null>;
};

export type CheckDiagnosis =
  | "client_known"
  | "secret_missing_or_mismatched"
  | "client_not_distributed_or_wrong_id"
  | "inconclusive";

export type CheckOutcome = {
  orgName: string;
  fhirBase: string;
  /** The Keychain item name (or env var name) the client ID came from --
   * never the client ID's origin secret, since client IDs are public. */
  clientIdSource: string;
  /** The Keychain item name (or env var name, or `"none"`) the client
   * secret came from -- never the secret value itself. */
  clientSecretSource: string;
  withSecret: TokenErrorProbe;
  withoutSecret: TokenErrorProbe;
  diagnosis: CheckDiagnosis;
  message: string;
};

/** A syntactically plausible but certainly-invalid authorization code.
 * `check` never has a real one -- it never opens the authorization URL or
 * talks to a browser -- so every token request it sends is expected to be
 * rejected; the rejection's `error` field is the whole point. */
const BOGUS_CODE = "kith-epic-feed-check-bogus-authorization-code";

function describeProbe(probe: TokenErrorProbe): string {
  return `${probe.status} ${probe.error ?? "(no error field)"}`;
}

function diagnose(
  withSecret: TokenErrorProbe,
  withoutSecret: TokenErrorProbe,
): { diagnosis: CheckDiagnosis; message: string } {
  const withSecretInvalidClient = withSecret.error === "invalid_client";
  const withoutSecretInvalidClient = withoutSecret.error === "invalid_client";
  const withSecretInvalidGrant = withSecret.error === "invalid_grant";
  const withoutSecretInvalidGrant = withoutSecret.error === "invalid_grant";

  // Checked before the more general "invalid_grant on either" case below,
  // since this combination is also "invalid_grant on either" but has a more
  // specific, more useful diagnosis.
  if (withSecretInvalidClient && withoutSecretInvalidGrant) {
    return {
      diagnosis: "secret_missing_or_mismatched",
      message:
        "invalid_client with the client secret, invalid_grant without it: " +
        "this organization already knows the client ID, but its " +
        "per-organization secret is not set or does not match. Store the " +
        "correct secret under this organization's Keychain item " +
        "(com.kithmind.epic.client-secret.<org-slug>) and run check again.",
    };
  }
  if (withSecretInvalidGrant || withoutSecretInvalidGrant) {
    return {
      diagnosis: "client_known",
      message:
        "invalid_grant on at least one attempt: this organization " +
        "recognizes the configured client ID, so authorize should work here.",
    };
  }
  if (withSecretInvalidClient && withoutSecretInvalidClient) {
    return {
      diagnosis: "client_not_distributed_or_wrong_id",
      message:
        "invalid_client on both attempts: either the production client " +
        "ID has not reached this organization yet (Epic says up to a day, " +
        "and organizations sync on their own schedule), or the wrong " +
        "client ID is stored. Wait and run check again, or verify the " +
        "stored client ID against the app's Manage keys page at " +
        "fhir.epic.com/Developer/Management.",
    };
  }
  return {
    diagnosis: "inconclusive",
    message:
      "Neither attempt returned invalid_client or invalid_grant (with " +
      `secret: ${describeProbe(withSecret)}; without secret: ` +
      `${describeProbe(withoutSecret)}). This does not match a known ` +
      "pattern; inspect the raw responses above.",
  };
}

/**
 * Resolves the FHIR base (directory lookup by `--org`, or the sandbox),
 * discovers the token endpoint, and sends a token request with a
 * deliberately bogus authorization code twice -- once with the configured
 * client secret (HTTP Basic) and once with no secret at all -- then prints
 * a diagnosis. Every dependency is injectable so a test drives this with no
 * network and no Keychain.
 */
export async function runCheck(
  args: CheckArgs,
  deps: CheckDeps = {},
): Promise<CheckOutcome> {
  const {
    fetchImpl = fetch,
    report = (line) => process.stdout.write(`${line}\n`),
    readKeychainItem = readKeychainSecretByService,
  } = deps;

  const env: EpicEnv = args.sandbox ? "sandbox" : epicEnv();
  const { orgName, fhirBase } = await resolveOrgForEnv(env, args.org, fetchImpl);
  report(`Checking ${orgName} (${env}) at ${fhirBase}`);

  const clientIdLookup = await loadClientIdWithSource(env, readKeychainItem);
  report(`Client ID: ${clientIdLookup.source}`);
  const secretLookup = await loadClientSecretForOrg(orgName, readKeychainItem);
  report(`Client secret: ${secretLookup.source}`);

  const discovery = await discoverSmartConfiguration(fhirBase, fetchImpl);
  const uri = redirectUri(env);

  const withoutSecret = await probeTokenRequest(
    {
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: clientIdLookup.clientId,
      clientSecret: null,
      code: BOGUS_CODE,
      redirectUri: uri,
    },
    fetchImpl,
  );

  let withSecret: TokenErrorProbe;
  if (secretLookup.secret !== null) {
    withSecret = await probeTokenRequest(
      {
        tokenEndpoint: discovery.tokenEndpoint,
        clientId: clientIdLookup.clientId,
        clientSecret: secretLookup.secret,
        code: BOGUS_CODE,
        redirectUri: uri,
      },
      fetchImpl,
    );
  } else {
    // Nothing to send Basic auth with; the with-secret attempt collapses
    // into the without-secret one already made above.
    withSecret = withoutSecret;
    report(
      "No client secret is configured for this organization; the " +
        "with-secret attempt was skipped and repeats the without-secret " +
        "result below.",
    );
  }

  report(
    `With secret: ${describeProbe(withSecret)}   ` +
      `Without secret: ${describeProbe(withoutSecret)}`,
  );
  const { diagnosis, message } = diagnose(withSecret, withoutSecret);
  report(message);

  return {
    orgName,
    fhirBase,
    clientIdSource: clientIdLookup.source,
    clientSecretSource: secretLookup.source,
    withSecret,
    withoutSecret,
    diagnosis,
    message,
  };
}
