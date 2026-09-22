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
| `kith-plaid-feed link`      | Starts a local server (fixed port, default 8765) serving one page that runs Plaid Link, so the owner can add institutions one at a time. |
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

4. **Register the OAuth redirect URI.** Morgan Stanley uses Plaid's OAuth
   flow, which requires the redirect URI to be registered in advance. In the
   [Plaid dashboard](https://dashboard.plaid.com), go to **Developers > API >
   Allowed redirect URIs** and add exactly:

   ```
   http://localhost:8765/oauth
   ```

   (or `http://localhost:<port>/oauth` if `link --port` overrides the
   default). This must match byte-for-byte what `link` sends as
   `redirect_uri`.

   Plaid's own API documentation for `redirect_uri` says: "When used in
   Production, must be an https URI." This package still uses
   `http://localhost:8765/oauth` because `link` only ever runs as a local
   loopback server the owner opens by hand -- there is no HTTPS endpoint to
   put there. If Plaid's dashboard refuses to register a `http://localhost`
   redirect URI in Production, or refuses to complete Morgan Stanley's OAuth
   handoff at that URI at run time, this needs a follow-up (an `ngrok`-style
   HTTPS tunnel, or Plaid's Hosted Link, in front of the same local server)
   that is out of scope here. Run `link` once against Morgan Stanley and
   confirm the OAuth round trip completes before relying on it.

## `link`

```sh
pnpm --filter @repo/plaid-feed build
node packages/plaid-feed/dist/cli.js link
# or, once installed as a bin: kith-plaid-feed link [--port 8765]
```

Open `http://localhost:8765` in a browser on the same machine, click "Link an
institution", and sign in through Plaid's own UI (never this page). Repeat for
each institution; the page lists what is already linked and shows a "needs
relink" note next to anything `pull` has reported as
`ITEM_LOGIN_REQUIRED`. Products requested are `investments` and
`transactions`, which restricts Link to institutions that support both --
if an institution the owner wants is not offered, that is the product list to
revisit (Plaid's `optional_products`/`required_if_supported_products` are the
usual fix, not attempted here).

On success, `link`:

1. Exchanges the `public_token` for an access token server-side.
2. Writes the access token to the Keychain:
   `security add-generic-password -U -a "$USER" -s com.kithmind.plaid.item.<institution_slug> -w <token>`.
   The token is never printed or logged.
3. Upserts a `kith.plaid_items` row (`item_id`, `institution_id`,
   `institution_name`, `keychain_service`, `linked_at`).

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

A product an institution does not support (Chase has no investment accounts;
some brokerages support no transactions) is not a failure -- it reports zero
for that product and moves on. `ITEM_LOGIN_REQUIRED`, from any call, ends that
item's pull immediately, sets `needs_relink_at` on the item row, and is
**not** retried in this process; the owner re-runs `link` for that
institution.

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

`test/mapping.test.mjs` and `test/pull.test.mjs` are unit tests against a
mocked Plaid client and a fake `pg.Pool` (an object recording `.query()`
calls) -- no network, no database. Run them against the built package:

```sh
pnpm --filter @repo/plaid-feed build
node --test packages/plaid-feed/test/*.test.mjs
```

A migration-apply test lives in
`packages/kith-store/test/kithSchema.test.mjs` (it already asserts every
migration's tables exist; this package's tables were added to that list) and
runs against a throwaway Postgres when `KITH_STORE_DATABASE_URL` is set.
