# @repo/plaid-feed

A daily Plaid feed so the owner sees current balances and holdings for four
institutions (Morgan Stanley, Vanguard, Fidelity, Chase) without being at the
keyboard. See
[`docs/plans/2026-09-22-simplification-and-feeds.md`](../../docs/plans/2026-09-22-simplification-and-feeds.md),
order of work item 1, for why this exists: current values come from this feed
now, not from PDF statement parsing.

Two commands:

| Command                    | What it does                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `kith-plaid-feed link`      | Creates a Plaid Hosted Link session, prints a URL to open in any browser, and waits for that one institution to finish linking. |
| `kith-plaid-feed pull`      | For every linked institution, pulls current balances, holdings and recent transactions and upserts them.          |

## One-time setup

1. **Plaid credentials.** Add three Keychain items (never commit these):

   ```sh
   security add-generic-password -a "$USER" -s com.kithmind.plaid.client-id -w <client-id>
   security add-generic-password -a "$USER" -s com.kithmind.plaid.secret -w <secret>
   ```

   `PLAID_CLIENT_ID` and `PLAID_SECRET` override the Keychain if set.
   `PLAID_ENV` defaults to `production` (the owner's Plaid plan is Trial,
   which only runs against Plaid's production environment); set it to
   `sandbox` or `development` to test against a different one.

2. **Database.** `DATABASE_URL` overrides; otherwise this reads the same
   Keychain item name the deferred-work daemon's wrapper script exports as
   `KITH_STORE_DATABASE_URL` (see
   [`docs/worker-service.md`](../../docs/worker-service.md), "Deferred work
   daemon"): `com.kithmind.deferred-work.database-url`.

3. **Apply the migration** (development database first, per AGENTS.md):

   ```sh
   pnpm --filter @repo/kith-store build
   KITH_STORE_DATABASE_URL=postgres://... node -e '
     import("@repo/kith-store/dist/index.js").then(async ({ applyKithSchema, createKithPool }) => {
       const pool = createKithPool(process.env.KITH_STORE_DATABASE_URL);
       const client = await pool.connect();
       try { console.log(await applyKithSchema(client)); }
       finally { client.release(); await pool.end(); }
     });
   '
   ```

   or run it however the rest of the `kith` schema is normally migrated in
   this deployment.

No dashboard step is required beyond the client id and secret above: Hosted
Link (below) needs no registered redirect URI. Confirm Hosted Link is
enabled for the Plaid account if `link` reports that Plaid did not return a
`hosted_link_url`.

## `link`

```sh
pnpm --filter @repo/plaid-feed build
node packages/plaid-feed/dist/cli.js link [--timeout MINUTES]
# or, once installed as a bin: kith-plaid-feed link
```

Run `link` on the mini, open the URL it prints in any browser (this machine
or another device), finish the bank's own sign-in there, then come back --
`link` finishes on its own once Plaid reports the session done. One
institution per run; run it again for the next one.

Why this way rather than a local server: Plaid confirms `http://localhost`
redirect URIs work only in Sandbox, so a locally-hosted Link page cannot
complete Morgan Stanley's OAuth handoff in Production. Plaid's own Hosted
Link instead serves the whole flow -- OAuth included -- from Plaid's `https`
URL, so there is no redirect URI to register and no dashboard step at all.

Products requested are `transactions` (required) and `investments`
(optional), so an institution with no investment accounts -- Chase -- is
still offered by Link; `pull` skips the investments calls for an item that
did not end up consenting to `investments`.

Under the hood, `link`:

1. Creates a `link_token` configured for Hosted Link and prints the URL.
2. Polls `/link/token/get` every few seconds (default timeout 15 minutes,
   `--timeout` overrides) until that session finishes.
3. Reads the `public_token` out of the finished session's own results and
   exchanges it for an access token server-side.
4. Writes the access token to the Keychain:
   `security add-generic-password -U -a "$USER" -s com.kithmind.plaid.item.<institution_slug> -w <token>`.
   The token is never printed or logged.
5. Upserts a `kith.plaid_items` row (`item_id`, `institution_id`,
   `institution_name`, `keychain_service`, `linked_at`).

If the owner closes the window without finishing, `link` reports that and
exits non-zero without writing anything. If the timeout passes first, it
reports a timeout and exits non-zero; run it again.

## `pull`

```sh
node packages/plaid-feed/dist/cli.js pull
# or: kith-plaid-feed pull
```

For every `kith.plaid_items` row: reads the access token from the Keychain,
then calls `/accounts/balance/get`, `/investments/holdings/get`,
`/transactions/sync` (cursor persisted per item) and
`/investments/transactions/get` for the last 30 days, and upserts everything.
One dated snapshot per account per day is written to
`kith.plaid_balance_snapshots` and `kith.plaid_holding_snapshots` (unique per
account per `as_of`, so a same-day re-run overwrites rather than duplicates).

An item whose consented products do not include `investments` (Chase) has
the holdings and investment-transactions calls skipped outright, not
attempted and not treated as a failure. An item that did consent to
`investments` but still turns out to have no investment accounts gets the
same zero result by tolerating Plaid's `PRODUCTS_NOT_SUPPORTED` response
instead. `ITEM_LOGIN_REQUIRED`, from any call, ends that item's pull
immediately, sets `needs_relink_at` on the item row, and is **not** retried
in this process; the owner re-runs `link` for that institution.

Prints one line per item, counts only, never a balance, holding value or
transaction amount:

```
plaid pull item=ins_... institution="Chase" status=ok accounts=2 balances=2 holdings=0 tx_added=14 tx_modified=1 tx_removed=0 inv_tx=0
```

Exits non-zero if any item's status is not `ok`, so a launchd job's exit
status is meaningful.

## Tables (migration `043_plaid_feed.sql`)

`plaid_items`, `plaid_accounts`, `plaid_securities`,
`plaid_balance_snapshots`, `plaid_holding_snapshots`, `plaid_transactions`,
`plaid_investment_transactions`, all in the `kith` schema and all
owner-global (no `space_id`), matching every existing finance table in this
codebase. No triggers, no change-feed rows, no immutable generations, no
receipts.

## Running `pull` daily

An example LaunchAgent, modeled on this deployment's own
`com.kithmind.deferred-work.plist` shape (same `Label`/`ProgramArguments`/
`WorkingDirectory`/`StandardOutPath`/`StandardErrorPath` fields), but with
`StartCalendarInterval` instead of `KeepAlive`: `pull` is a one-shot command
that exits, not a long-running process. Copy this into a real `.plist` file,
replace every ALL-CAPS placeholder, and follow
[`docs/worker-service.md`](../../docs/worker-service.md)'s "Deferred work
daemon" section for the Keychain wrapper-script pattern (export
`DATABASE_URL`, `PLAID_CLIENT_ID` and `PLAID_SECRET` from Keychain items the
same way that daemon's wrapper exports `KITH_STORE_DATABASE_URL`, rather than
putting secrets in the plist itself). No personal path, account name, or
credential value belongs in the plist or its copy.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kithmind.plaid-feed-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/kithmind-plaid-feed-pull-watch.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/ABSOLUTE/PATH/TO/REPOSITORY</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/PRIVATE-LOG-DIRECTORY/plaid-feed-pull.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/PRIVATE-LOG-DIRECTORY/plaid-feed-pull.stderr.log</string>
</dict>
</plist>
```

The wrapper script this `ProgramArguments` entry names is one line different
from the filesystem worker's own `examples/worker-service/macos-keychain-watch.sh`:
it reads the Plaid client id, secret and database URL from their own Keychain
items (the same three items `pull` itself falls back to, so the wrapper can
instead just leave them unset and let `pull` read the Keychain directly), and
execs:

```
exec /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/REPOSITORY/packages/plaid-feed/dist/cli.js pull
```

`pull`'s non-zero exit on any item failure is what makes launchd (and any
monitoring reading `StandardErrorPath`) show a failed run.

## Tests

`test/mapping.test.mjs`, `test/pull.test.mjs` and `test/link.test.mjs` are
unit tests against a mocked Plaid client and a fake `pg.Pool` (an object
recording `.query()` calls) -- no network, no database, and (for the
Hosted Link polling flow) no real waiting, since the clock and Keychain
writer are injected. Run them against the built package:

```sh
pnpm --filter @repo/plaid-feed build
node --test packages/plaid-feed/test/*.test.mjs
```

A migration-apply test lives in
`packages/kith-store/test/kithSchema.test.mjs` (it already asserts every
migration's tables exist; this package's tables were added to that list) and
runs against a throwaway Postgres when `KITH_STORE_DATABASE_URL` is set.
