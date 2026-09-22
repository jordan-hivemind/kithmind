# @repo/plaid-feed

A daily Plaid feed so the owner sees current balances and holdings for four
institutions (Morgan Stanley, Vanguard, Fidelity, Chase) without being at the
keyboard. See
[`docs/plans/2026-09-22-simplification-and-feeds.md`](../../docs/plans/2026-09-22-simplification-and-feeds.md),
order of work item 1, for why this exists: current values come from this feed
now, not from PDF statement parsing.

Three commands:

| Command                       | What it does                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `kith-plaid-feed link`          | Creates a Plaid Hosted Link session, prints a URL to open in any browser, and waits for that one institution to finish linking.        |
| `kith-plaid-feed pull`          | For every linked institution, pulls current balances, holdings and recent transactions and upserts them into the unified ledger.       |
| `kith-plaid-feed import-archive` | One-time (idempotent) import of the finance archive's own statement history into the same unified ledger. See "`import-archive`" below. |

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
`/transactions/sync` (cursor persisted per item, and paged for as long as
Plaid reports `has_more` -- there is no page cap) and
`/investments/transactions/get` (window depends on whether this item has been
pulled before -- see "History depth" below), and upserts everything into the
unified ledger tables (see "Tables" below), tagged `source = 'plaid'`. One
dated snapshot per account per day is written to
`kith.fin_balance_snapshots` and `kith.fin_holding_snapshots` (unique per
account per `as_of` per source, so a same-day re-run overwrites rather than
duplicates).

An item whose consented products do not include `investments` (Chase) has
the holdings and investment-transactions calls skipped outright, not
attempted and not treated as a failure. An item that did consent to
`investments` but still turns out to have no investment accounts gets the
same zero result by tolerating Plaid's `PRODUCTS_NOT_SUPPORTED` response
instead. `ITEM_LOGIN_REQUIRED`, from any call, ends that item's pull
immediately, sets `needs_relink_at` on the item row, and is **not** retried
in this process; the owner re-runs `link` for that institution.

A currency is recorded as Plaid's `iso_currency_code` when present,
otherwise its `unofficial_currency_code` (a crypto ticker, or a code longer
than three letters), trimmed and uppercased; migration `044_plaid_currency.sql`
relaxed every `currency` CHECK to a bounded length so that value is never
rejected. Every other optional Plaid string (`subtype`, `type`, `name`,
`merchant_name`, `category`, `official_name`, `mask`, `ticker_symbol`) is
trimmed and an empty result mapped to `null` before it is written; migration
`047_plaid_strings.sql` additionally relaxed every bounded-length CHECK on
these columns to accept an empty string too, after a second real pull failed
partway through -- after 949 investment-transaction rows had already been
written -- on a `subtype` value Plaid sent as `""` rather than omitted. A
single security, holding, transaction or investment-transaction row whose
own upsert still fails for some other reason does not end the item's pull:
it is counted in `row_failures` and the rest of that item, including its
balances and transactions, is still written. A transaction or
investment-transaction row failure additionally keeps that call's own
cursor or watermark from advancing past the window it happened in, so a
retried pull sees the failed row again instead of skipping past it.

Prints one line per item, counts only, never a balance, holding value or
transaction amount:

```
plaid pull item=ins_... institution="Chase" status=ok accounts=2 balances=2 holdings=0 tx_added=14 tx_modified=1 tx_removed=0 inv_tx=0 row_failures=0
```

Exits non-zero if any item's status is not `ok` or it had any `row_failures`,
so a launchd job's exit status is meaningful.

## History depth

The owner wants as much transaction history as Plaid will give, not just
recent activity, but Plaid bounds the two transaction products differently:

- **Banking transactions** (`/transactions/sync`): how far back Plaid keeps
  history for an Item is set by `days_requested` on the *link token*, fixed
  the moment the Item is created. `link` now requests **730 days** (Plaid's
  documented maximum; the default is 90). This only affects an institution
  linked *after* this change -- **an Item linked before this change keeps
  its original banking window unless it is removed and re-linked** (Plaid
  gives no way to widen an existing Item's window in place).
- **Investment transactions** (`/investments/transactions/get`): Plaid keeps
  up to **24 months** of these before the Item was linked, and every call
  takes an explicit `start_date`/`end_date` rather than depending on the
  link token. `pull` tracks how far each item's investment-transaction
  history has been pulled in `kith.plaid_items.investment_transactions_pulled_through`
  (migration `045_plaid_history.sql`). The first pull for an item (that
  column is `NULL`) requests the full 24-month window, paging with
  `count`/`offset` (500 per page, Plaid's maximum) until every transaction
  in the window has been fetched. Every later pull requests only from that
  column's value minus 7 days -- to catch transactions that post a few days
  after their own dated day -- through today, and the column is only
  updated once a window's pages all succeed, so a page that fails partway
  through does not advance the watermark past transactions this pull never
  actually saw.

## `import-archive`

```sh
node packages/plaid-feed/dist/cli.js import-archive [--link ARCHIVE_ACCOUNT_ID=PLAID_ACCOUNT_ID]... [--unlink ARCHIVE_ACCOUNT_ID]...
# or: kith-plaid-feed import-archive
```

A self-repairing (idempotent, safe to re-run) read of the finance archive
(statement-derived, Morgan Stanley only, `finance.transactions` 2020 to
present) into the same unified ledger tables `pull` writes into, tagged
`source = 'plaid'` above and `source = 'archive'` here -- see
docs/plans/2026-09-22-simplification-and-feeds.md: the owner does not want
the archive and the Plaid feed to be two ledgers to query separately.

Read-only against the archive (`FINANCE_ARCHIVE_READER_DATABASE_URL`, the
archive's own reader-role connection string, the same one the MCP gateway
uses); the finance-archive write path is never touched. Every archive query
schema-qualifies its tables (`${schema}.accounts`, not a bare `accounts`)
with whatever schema the connection is actually pinned to
(`archiveSchemaOf`, `finance` unless `FINANCE_ARCHIVE_SCHEMA` overrides it)
-- defense in depth on top of `createArchiveClient`'s own `search_path` pin,
so a same-named table earlier on the connection's `search_path` can never be
read by mistake. A startup guard (`assertArchiveSchemaReady`) confirms
`${schema}.accounts` is actually reachable before any real reading starts,
failing with a clear message rather than a bare "relation does not exist"
(or, worse, silently reading the wrong table) if it is not.

### Instrument matching (FIN-4)

An archive instrument is not one to one with a `kith.fin_securities` row: two
archive instrument ids can resolve to one existing security (the same CUSIP,
ISIN or ticker recorded twice under different archive instrument ids), and an
instrument can turn out to be re-matched onto a row that already carries a
different archive instrument's id. PR 435's first real production run
assumed the 1:1 shape migration 048's `archive_instrument_id text UNIQUE`
encoded and aborted with a unique-constraint violation the moment that
assumption turned out to be false, before any account repair ran at all.

Migration `051_fin_security_links.sql` drops that UNIQUE constraint (keeping
a plain index) and adds `kith.fin_security_links`, an archive-instrument-id
to `fin_securities`-id map: every archive instrument that is *not* the one
whose "no match yet" case originally created a security gets a row here.
`resolveArchiveInstrument` resolves each archive instrument, in order: a
security this exact instrument already created (its own
`fin_securities.archive_instrument_id`); an existing `fin_security_links`
row for it (authoritative, never re-matched); a match against the run's
current candidates by CUSIP, then ISIN, then ticker
(`matchArchiveInstrumentByIdentifierStrength` -- CUSIP and ISIN are less
ambiguous than a ticker, which a fund family can reuse across share classes),
recorded as a new `fin_security_links` row; or, with no match at all, a
brand-new security. A single instrument's own resolution failing is counted
under `instrument_conflicts` and skipped rather than aborting every
instrument after it -- its own transactions and positions still import, with
a `null` `security_id`.

`matchArchiveInstrument` (ticker, then CUSIP, then ISIN) is unchanged and
still used for its own callers; the CUSIP-first order above applies only to
what `resolveArchiveInstrument` persists as a link.

### Account matching (FIN-3)

A post-release audit of the owner's live database, after PR 433's first real
`import-archive` run, found 19 distinct archive accounts (`finance.accounts`)
collapsed onto only 5 `kith.fin_accounts` rows -- one per `account_type` at
the one archive institution, each row's transaction count equal to that
type's *whole archive total* (12 brokerage accounts on one row, 3 trust, 2
retirement). The cause: `finance.accounts.display_name` is null or generic
on this database, so every archive account with no display name fell back
to the same placeholder ("Unlabeled account"), and the original mask/name
matching could compare that placeholder as if it were real evidence,
including against another archive-only row. The audit also found 0 of 24
audited `acct_last4` values equal to any Plaid `mask` at the same
institution -- Plaid masks a different identifier than a statement's own
account number at this institution, so mask cannot be the primary link.

An archive account is identified only by its own archive id
(`archive_account_id`, UNIQUE on `kith.fin_accounts`). Matching tries, in
order:

1. **A manual override** (`--link`/`--unlink`, below) -- authoritative,
   checked first, and never overwritten by anything automatic.
2. **Holdings overlap** (`match_method = 'holdings'`), the primary method
   for an investment account: the latest position identifiers (CUSIP, else
   ISIN, else ticker, plus quantity) an archive account and a Plaid-linked
   account each report, compared by Jaccard similarity over the *set* of
   identifiers. A pair needs at least 2 identifiers in common and a Jaccard
   of at least 0.6; among qualifying pairs the highest Jaccard wins, ties
   broken by quantity agreement on the shared identifiers, and the
   assignment is one to one (a feed account already claimed by a
   better-scoring pair is never offered to a second archive account).
3. **Balance equality** (`match_method = 'balance'`), the primary method
   for an account with no holdings to compare -- a loan, a credit line,
   cash: the archive account's and the feed account's latest reported
   balances, within 1% of each other (relative to the larger) on dates no
   more than 45 days apart.
4. **Mask**, then **name** (`match_method = 'mask'`/`'name'`), kept as
   secondary fallbacks -- the original two methods. Neither ever considers
   an archive-only row (no `plaid_account_id` yet) a valid match target,
   and neither ever matches on a null, blank, or placeholder name on either
   side: identity comes only from an archive account's own
   `archive_account_id`, never from matching one archive-only row against
   another.

Every method that sets `archive_account_id` also records `match_method`
(migration `050_fin_account_matching.sql`) so a reader can see how a link
was made.

**`--link`/`--unlink`.** `--link ARCHIVE_ACCOUNT_ID=PLAID_ACCOUNT_ID`
(repeatable) pins an archive account to a specific feed account regardless
of what any automatic method would have picked, persisted in
`kith.fin_account_link_overrides` so it survives past the run that set it --
every later run reads this table before it tries anything automatic.
`--unlink ARCHIVE_ACCOUNT_ID` (repeatable) blocks automatic matching for
that archive account going forward and, if it is currently merged into a
feed row, immediately splits it back out to its own archive-only row. A
future `--link` for the same archive account overwrites either kind of
override; there is no separate "clear" command.

**Linking persists and self-repairs.** A match sets `archive_account_id` on
the matched `kith.fin_accounts` row (not just an in-memory pairing for that
run), so the Institutions screen's join from a feed account onto its archive
history works after every run, not only the run that first matched it. An
archive account already linked is never re-matched by anything automatic on
a later run -- that link is stable. If that link points at an archive-only
row (no feed account existed yet when it was created) and a feed account now
exists that matches by holdings, balance, mask or name, the archive-only
row's transactions and snapshots move onto the feed row, the feed row gets
`archive_account_id` set, and the now-empty archive-only row is deleted. A
candidate row already claimed by a different archive account this run is
never offered to a second archive account, so two archive accounts that
happen to share a generic display name -- or a coincidental holdings/balance
overlap -- can never collapse onto the same feed row.

**Self-repair for existing wrong rows.** On every run, before any linking
decision: every `kith.fin_transactions` row tagged `source = 'archive'`
carries `source_ref` = the archive's own `transactions.id`, a stable pointer
independent of whichever `fin_accounts` row an earlier, collapsed-matching
run wrote it onto. Joining that back to the archive's own `account_id` for
the same transaction gives the one ground truth for which account a row
belongs to; any row on the wrong `fin_accounts` row moves to the right one,
creating a `fin_accounts` row for that archive account first if none exists
yet. Holding and balance snapshots carry no equivalent per-row locator, so
they are reconciled instead: any existing `source = 'archive'` snapshot row
whose `(account_id, security_id, as_of)` (or `(account_id, as_of)` for a
balance) is not part of the full, currently-correct universe this run
already knows is deleted, and the normal insert pass below reinserts
exactly the correct set. Whatever archive-only `fin_accounts` row that
reattribution and reconciliation leaves with no rows at all and no feed
link -- a stale bucket nothing legitimately owns any more -- is then
deleted. Prints these counts only: accounts and links by method, rows
moved (`rows_reattributed`), rows deleted as overlap, and empty accounts
removed -- never an account name, balance or transaction amount.

**Boundary rule**: an account that already has Plaid transactions in the
ledger only gets archive transactions strictly before the earliest Plaid
date already there -- the archive is history, Plaid is the current feed, and
importing archive rows past where Plaid's own history starts would
duplicate coverage under two sources rather than extend it. The same rule
applies to holding and balance snapshots, against the earliest Plaid
snapshot date (holding or balance, whichever is earlier). An account with no
Plaid transactions (or no Plaid snapshots) yet gets its entire archive
history for that row kind. Every run re-derives both boundaries from the
ledger's current Plaid rows, **deletes** any archive-source row already on
or after its boundary (left behind by an earlier, boundary-blind or
not-yet-linked run), and reinserts whatever belongs before it -- so a run
against already-correct data deletes and inserts nothing, and a run against
data an earlier bug mis-imported repairs it in place. The more conservative
(earlier) of the two boundaries is recorded on
`kith.fin_accounts.archive_coverage_through` (migration
`049_fin_archive_coverage.sql`) as the boundary this run applied for that
account, `null` when the account has no Plaid data yet.

Prints counts only, the same rule `pull` follows:

```
plaid import-archive accounts_matched=3 links_set=1 links_holdings=2 links_balance=0 links_mask=0 links_name=0 links_manual=1 archive_only_accounts=1 rows_inserted=4108 rows_reattributed=0 rows_deleted_as_overlap=6 empty_accounts_removed=0 boundary_date_count=2 accounts_created=1 accounts_merged=0 instruments_matched=12 instruments_created=2 instrument_conflicts=0 transactions_imported=4094 transactions_skipped_past_boundary=214 positions_imported=340 positions_skipped_no_instrument=0 positions_skipped_past_boundary=5 balances_imported=48 balances_skipped_past_boundary=2
```

### Phased, so a failure never discards what already ran (FIN-4)

`import-archive` runs in phases -- setup, instruments, accounts, self-repair,
boundary, rows -- each wrapped so a failure partway through still returns the
counts every completed phase produced, rather than throwing the whole run's
counts away the way PR 435's first real run did. A failed phase's name is
printed as `phase_failed=<phase>` on the summary line above (the phase name
only; the underlying error goes to stderr, since it may not be counts-only),
and the CLI exits non-zero.

## Tables (migrations `043_plaid_feed.sql`, `044_plaid_currency.sql`, `045_plaid_history.sql`, `047_plaid_strings.sql`, `048_finance_unify.sql`, `049_fin_archive_coverage.sql`, `050_fin_account_matching.sql`, `051_fin_security_links.sql`)

`kith.plaid_items` is Plaid item state only -- the Keychain pointer, the
`/transactions/sync` cursor, the investment-transaction watermark,
`needs_relink_at` -- not ledger data.

Migration `048_finance_unify.sql` replaced the Plaid-only
`plaid_accounts`/`plaid_securities`/`plaid_balance_snapshots`/
`plaid_holding_snapshots`/`plaid_transactions`/`plaid_investment_transactions`
tables with one unified ledger over both the archive and the Plaid feed:
`kith.fin_accounts`, `kith.fin_securities`, `kith.fin_transactions`,
`kith.fin_holding_snapshots` and `kith.fin_balance_snapshots`. Every ledger
row carries `source` (`'archive'` or `'plaid'`); a transaction or a snapshot
row is unique per source (a transaction by `(source, source_ref)`, a
snapshot by `(account_id, as_of[, security_id], source)`), so the two
sources' rows sit side by side rather than overwriting each other.

Migration `049_fin_archive_coverage.sql` adds
`kith.fin_accounts.archive_coverage_through` (nullable `date`): the overlap
boundary `import-archive` last applied for that account. `import-archive`
re-derives and rewrites it on every run; it is not authoritative on its own,
just a cache of the boundary the last run applied.

Migration `050_fin_account_matching.sql` adds `kith.fin_accounts.match_method`
(`holdings`/`balance`/`mask`/`name`/`manual`, nullable -- see "Account
matching (FIN-3)" above) and `kith.fin_account_link_overrides`, an owner's
persisted `--link`/`--unlink`.

Migration `051_fin_security_links.sql` drops the UNIQUE constraint on
`kith.fin_securities.archive_instrument_id` (kept as a plain index) and adds
`kith.fin_security_links` -- see "Instrument matching (FIN-4)" above.

All in the `kith` schema and all owner-global (no `space_id`), matching
every existing finance table in this codebase. No triggers, no change-feed
rows, no immutable generations, no receipts.

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

`test/mapping.test.mjs`, `test/pull.test.mjs`, `test/link.test.mjs` and
`test/importArchive.test.mjs` are unit tests against a mocked Plaid client
and a fake `pg.Pool` (an object recording `.query()` calls) -- no network,
no database, and (for the Hosted Link polling flow) no real waiting, since
the clock and Keychain writer are injected. Run them against the built
package:

```sh
pnpm --filter @repo/plaid-feed build
node --test packages/plaid-feed/test/*.test.mjs
```

`test/ledger.test.mjs` is the one exception: `import-archive`'s matching,
linking, boundary rule and FIN-3 self-repair reconciling archive-style
accounts against Plaid-style ones, end to end against a real throwaway
Postgres (its own database on whatever server `KITH_STORE_DATABASE_URL`
points at, created and dropped by the test). Ten scenarios: a straight
mask match with the boundary rule and a second, idempotent run; an
archive-only account merging into a feed account that shows up later, with
self-repair deleting the now-past-boundary archive row that an earlier,
feed-less run had no boundary to skip it against; two archive accounts at
the same institution linking to their own distinct feed accounts rather
than collapsing onto one; the FIN-3 collapse repro (three same-institution,
same-type archive accounts with a null display name each getting their own
row); holdings-overlap linking two investment accounts to their correct
Plaid accounts when masks disagree; balance matching a credit-line/loan
account with no holdings; a persisted `--link` override taking precedence
over mask matching; self-repair moving a misattributed transaction from
a wrong bucket account to the correct one, with a second, idempotent run;
the FIN-4 instrument repro (two archive instruments sharing one CUSIP plus a
third already resolved by an earlier run's `fin_security_links` row,
resolving without a unique violation across two runs, with transactions
attributed to the right security); and a synthetic rows-phase failure
proving the instruments and accounts phases' counts survive on the returned
result. Skips cleanly without `KITH_STORE_DATABASE_URL` set, and runs as part of the
same `node --test packages/plaid-feed/test/*.test.mjs` command above.
`test/importArchive.test.mjs` additionally covers the pure matching
functions with no database at all, including the placeholder-name and
archive-only-row guards `matchArchiveAccount` enforces and the holdings
overlap/balance equality assignment functions.

A migration-apply test lives in
`packages/kith-store/test/kithSchema.test.mjs` (it already asserts every
migration's tables exist, and that the tables migration 048 retired do not)
and runs against a throwaway Postgres when `KITH_STORE_DATABASE_URL` is set.
