// `kith-plaid-feed link`: Plaid Hosted Link.
//
// Plaid confirms `http://localhost` redirect URIs work only in Sandbox, so a
// local server driving Plaid's own Link JS -- a redirect back to this
// machine for OAuth institutions -- cannot complete Morgan Stanley's OAuth
// handoff in Production. Hosted Link sidesteps that: Plaid serves the whole
// Link flow, OAuth included, from its own `https` URL, so nothing here needs
// a redirect URI, a local server, or a dashboard registration step at all.
//
// This command creates a Hosted Link session, prints the URL for the owner
// to open in any browser, and polls `/link/token/get` until that session
// finishes. On success it reads the `public_token` out of the session's own
// results, exchanges it, writes the access token to the Keychain and upserts
// the item -- exactly what the old server-based `/api/exchange` handler did,
// just fed from a poll instead of a browser POST.
//
// One institution per run: run `link` again for the next one.

import type { Pool } from "pg";
import { CountryCode, Products, type PlaidApi } from "plaid";

import {
  itemKeychainService,
  loadDatabaseUrl,
  loadPlaidCredentials,
} from "./config.js";
import { openPool, upsertPlaidItem } from "./db.js";
import { writeKeychainSecret } from "./keychain.js";
import { createPlaidClient } from "./plaidClient.js";

const CLIENT_USER_ID = "kithmind-household";

/** How often the session is polled while the owner is off in their browser. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** "Support a `--timeout` (default 15 minutes)." */
export const DEFAULT_LINK_TIMEOUT_MS = 15 * 60 * 1000;

export type LinkOutcome =
  | { status: "linked"; institutionName: string; itemId: string }
  | { status: "exited"; message: string | null }
  | { status: "timeout" };

type ItemAddResult = {
  public_token: string;
  institution: { name?: string; institution_id?: string } | null;
};

export type LinkDeps = {
  client: PlaidApi;
  pool: Pool;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable so a test never actually waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so a test can drive the deadline without real time passing. */
  now?: () => number;
  /** Injectable so a test never touches the real Keychain. */
  writeSecret?: (service: string, secret: string) => Promise<void>;
  /** Where the hosted URL and progress are reported. Defaults to stdout. */
  report?: (line: string) => void;
};

/**
 * One Hosted Link session: create it, print the URL, poll until the owner
 * finishes (or exits, or the timeout passes), and on success exchange and
 * store the result. Pure aside from its injected dependencies, so a test
 * drives it against a mocked Plaid client and a fake pool with no network,
 * no database, no Keychain and no real waiting.
 */
export async function runHostedLink(deps: LinkDeps): Promise<LinkOutcome> {
  const {
    client,
    pool,
    timeoutMs = DEFAULT_LINK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    writeSecret = writeKeychainSecret,
    report = (line) => process.stdout.write(`${line}\n`),
  } = deps;

  const created = await client.linkTokenCreate({
    client_name: "Kith Mind",
    language: "en",
    country_codes: [CountryCode.Us],
    user: { client_user_id: CLIENT_USER_ID },
    // Only `transactions` is required so depository-only institutions
    // (Chase) are still offered; `investments` is requested where an
    // institution supports it (Morgan Stanley, Vanguard, Fidelity) but does
    // not narrow the picker for the ones that do not.
    products: [Products.Transactions],
    optional_products: [Products.Investments],
    hosted_link: {},
  });
  const linkToken = created.data.link_token;
  const hostedUrl = created.data.hosted_link_url;
  if (hostedUrl === undefined) {
    throw new Error(
      "Plaid did not return a hosted_link_url. Confirm Hosted Link is enabled for this Plaid account.",
    );
  }
  report("Open this URL to link an institution (it finishes automatically once you're done):");
  report(hostedUrl);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await client.linkTokenGet({ link_token: linkToken });
    const session = status.data.link_sessions?.[0];
    if (session?.finished_at) {
      const itemAdd = session.results?.item_add_results?.[0];
      if (itemAdd !== undefined) {
        return await finishLink(client, pool, itemAdd, writeSecret);
      }
      const error = session.exit?.error ?? null;
      return { status: "exited", message: error?.error_message ?? null };
    }
    await sleep(pollIntervalMs);
  }
  return { status: "timeout" };
}

async function finishLink(
  client: PlaidApi,
  pool: Pool,
  itemAdd: ItemAddResult,
  writeSecret: (service: string, secret: string) => Promise<void>,
): Promise<LinkOutcome> {
  const institutionName = itemAdd.institution?.name ?? "Unknown institution";
  const institutionId = itemAdd.institution?.institution_id ?? "unknown";
  const exchange = await client.itemPublicTokenExchange({
    public_token: itemAdd.public_token,
  });
  const keychainService = itemKeychainService(institutionName);
  // Never logged: written straight from the exchange response to the
  // Keychain.
  await writeSecret(keychainService, exchange.data.access_token);
  await upsertPlaidItem(pool, {
    itemId: exchange.data.item_id,
    institutionId,
    institutionName,
    keychainService,
  });
  return { status: "linked", institutionName, itemId: exchange.data.item_id };
}

/** The CLI entry point: resolves credentials and the database, runs one
 * Hosted Link session, and reports the outcome. */
export async function runLink(timeoutMs?: number): Promise<LinkOutcome> {
  const [credentials, databaseUrl] = await Promise.all([
    loadPlaidCredentials(),
    loadDatabaseUrl(),
  ]);
  const client = createPlaidClient(credentials);
  const pool = openPool(databaseUrl);
  try {
    const outcome = await runHostedLink({ client, pool, timeoutMs });
    if (outcome.status === "linked") {
      process.stdout.write(`Linked ${outcome.institutionName}.\n`);
    } else if (outcome.status === "exited") {
      process.stdout.write(
        `Link session ended without linking an institution${
          outcome.message !== null ? `: ${outcome.message}` : "."
        }\n`,
      );
    } else {
      process.stdout.write(
        "Timed out waiting for the Link session to finish. Run link again.\n",
      );
    }
    return outcome;
  } finally {
    await pool.end();
  }
}
