# Onboarding runbook

This is the runbook for a new adopter setting up their own Kith Mind
deployment end to end: the database and web app, the daily finance feed, the
document folder, and health records. It replaces piecing together the older,
per-feature documents. Those documents still exist for the optional history
path; each one now links back here.

## What you get

| Area | What it gives you |
| --- | --- |
| Web app | A personal knowledge base you and connected AI assistants can read and write, over MCP. See the root [`README.md`](../README.md). |
| Finance | Daily account balances and holdings from a Plaid feed, shown on the Balances and Institutions pages and readable by MCP tools. |
| Documents | A folder (local or provider-synced) walked on a schedule, with returns and K-1s kept in full and everything else kept as metadata plus a first page. |
| Health | Planned: structured records from Epic's patient-facing FHIR API. Not yet implemented; see "Health records with Epic MyChart" below for the honest current state. |

## Prerequisites

| Prerequisite | Detail |
| --- | --- |
| Node.js | 22 or newer (the finance and document packages need 24.10 or newer; see their `package.json` `engines`). |
| pnpm | 10.20, the version this repository pins. |
| PostgreSQL | 17 or newer with the `vector` extension, such as a Neon project. The web app reads its connection string as a Vercel environment variable (`docs/self-hosting.md`); the local CLIs below read the same database from either an environment variable or the macOS Keychain item `com.kithmind.deferred-work.database-url`. |
| A document folder | A local folder or a folder synced by a provider such as Dropbox, iCloud Drive, Google Drive or OneDrive. A provider is optional -- this works against a plain local folder too -- but you will want backup of both the folder and the database. Neon and Dropbox (or an equivalent) each provide their own backup; this deployment does not add a second, separate backup on top of them. |

## Database setup

Create a PostgreSQL 17+ database with the `vector` extension available (Neon
provides both). Full deployment detail, including the app-role grants and
Vercel environment variables, is in [`docs/self-hosting.md`](self-hosting.md);
this section covers only applying the schema.

Apply the `kith` schema with `applyKithSchema`
(`packages/kith-store/src/schema.ts`), against the migrations in
`packages/kith-store/migrations`, using a role that can create objects:

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

`applyKithSchema` is idempotent: rerunning it after a later `pnpm install`
picks up any new migration without redoing earlier ones. The finance feed and
document ingester below both depend on this schema; apply it before either.

## Web app and sign-in

Follow the root [`README.md`](../README.md)'s "Use it with Claude or ChatGPT"
steps 1 through 3: fork the repository, follow
[`docs/self-hosting.md`](self-hosting.md) to deploy one PostgreSQL database
and one Vercel project, then open the deployed web app and create your
account. That account owns your Personal space, and every finance and
document record this runbook sets up lands there. Connect Claude, ChatGPT or
Claude Code to `https://your-project.vercel.app/api/mcp` as the README
describes, granting read permission first.

## Finance feed with Plaid

[`packages/plaid-feed`](../packages/plaid-feed) is the daily feed: link once
per institution, then pull balances, holdings and transactions on a schedule.
See [its README](../packages/plaid-feed/README.md) for full detail; this is
the setup path.

1. **Create a Plaid account.** Choose Personal use and the Trial plan. A
   Trial plan only runs against Plaid's Production environment (not
   Sandbox), which `packages/plaid-feed/src/config.ts` accounts for: `PLAID_ENV`
   defaults to `production`.
2. **Store the credentials.** Copy the client ID and the Production secret
   from the Plaid dashboard into two Keychain items, or the environment
   overrides:

   ```sh
   security add-generic-password -a "$USER" -s com.kithmind.plaid.client-id -w <client-id>
   security add-generic-password -a "$USER" -s com.kithmind.plaid.secret -w <secret>
   ```

   `PLAID_CLIENT_ID` and `PLAID_SECRET` override the Keychain items if set.
3. **Build and link one institution at a time:**

   ```sh
   pnpm --filter @repo/plaid-feed build
   node packages/plaid-feed/dist/cli.js link
   # or, once installed as a bin: kith-plaid-feed link
   ```

   `link` prints a Plaid Hosted Link URL. Open it in any browser, sign in to
   the bank there, and come back -- `link` finishes on its own once Plaid
   reports the session done. Run it again for the next institution.
4. **Pull:**

   ```sh
   node packages/plaid-feed/dist/cli.js pull
   ```

   `pull` reads every linked institution's balances, holdings and
   transactions and upserts them into the unified ledger tables.
5. **Schedule `pull` daily** with a LaunchAgent. An example plist and the
   Keychain-reading wrapper-script pattern are in the plaid-feed README's
   "Running `pull` daily" section; copy it, replace the placeholders, and
   `launchctl load` it.

**Plaid's own limits, not this repository's:**

| Limit | Detail |
| --- | --- |
| Banking history | 730 days, set once at link time. An institution linked before a change to this setting keeps its original window; Plaid has no way to widen an existing item's window without removing and re-linking it. |
| Investment history | 24 months, pulled incrementally after the first full pull. |
| Re-linking | Plaid occasionally requires a fresh Hosted Link session for an institution (see `ITEM_LOGIN_REQUIRED` under Troubleshooting). |
| Institution-side sharing toggle | Some banks require a separate "third party data sharing" toggle in their own online banking settings before Plaid can read that account. If `link` succeeds but `pull` sees no accounts, check the institution's own settings. |

## Documents

[`packages/ingest-simple`](../packages/ingest-simple) is the stateless
document ingester: point it at your document folder, and it walks, converts
and stages new or changed files into the same tables the web app reads. See
[its README](../packages/ingest-simple/README.md) for full detail.

```sh
pnpm --filter @repo/ingest-simple build
kith-ingest-simple --root <folder> --source-account <id> --root-alias <alias> --env-from-keychain
```

`--env-from-keychain` reads the model-provider environment (`OPENAI_API_KEY`,
`BRAIN_EMBED_MODEL`, `BRAIN_EMBED_MODEL_REVISION`) from the same Keychain
items the deferred-work daemon's wrapper script uses, for a shell that has
none of them exported. Find `--source-account` under `/admin/sources` in the
web app, or with the SQL query the ingest-simple README's "Finding the source
account ID" section gives.

**Depth policy.** Every file is classified from its filename and first page.
Returns and K-1s are kept in full, indefinitely. Everything else defaults to
page 1 plus metadata (page count, byte size, detected tax year) -- enough for
the assistant to know the document exists and where to find it, without
full-text indexing paperwork that does not need it. An encrypted PDF with no
working `--pdf-password` is still registered, by filename and metadata only.

**Embedding policy.** A space defaults to `all_chunks` (every chunk of every
document is eligible for semantic search) only if you set it there. Switch a
space explicitly with:

```sh
kith-ingest-simple --set-embedding-policy all_chunks --space <id> --env-from-keychain
```

**Schedule it hourly.** Copy
`packages/ingest-simple/com.kithmind.ingest-simple.plist.example` into a real
`.plist` under `~/Library/LaunchAgents/`, replace the placeholders, and
`launchctl load` it. It runs once an hour and exits; do not run it at the
same time as the old filesystem worker service against the same source
account (see "Optional: statement history beyond two years" below for what
that older path is).

## Health records with Epic MyChart

Register a patient-facing app at [fhir.epic.com](https://fhir.epic.com):

| Setting | Value |
| --- | --- |
| Audience | Patients |
| Resources | The R4 resource list your use case needs (for example Patient, Observation, DocumentReference, DiagnosticReport). |
| Client type | Confidential client with a public certificate. |
| Redirect URI | Your deployment's callback URL. |
| Refresh tokens | Enabled. |

A production client ID can take up to a day to activate after registration.
Each family member needs their own authorization, done through the account
holder's own proxy access in MyChart -- one authorization per person, not one
for the household.

**Honest current state:** the MyChart pull is in progress, not shipped. The
[simplification and feeds plan](plans/2026-09-22-simplification-and-feeds.md)
names it as order-of-work items 4 and 5 (Epic FHIR pull for the owner, then
each family member; MyChart message export and visit transcripts after
that). The planned package is `@repo/epic-feed` (alongside `@repo/plaid-feed`
and `@repo/ingest-simple`); it does not exist in this repository yet. Register
the app now so the production client ID is ready when the package lands --
that is the only step this section can honestly ask for today.

## Optional: statement history beyond two years

Plaid's own limits (24 months of investment history, and a banking window set
at link time) mean the feed alone does not reach further back. This section
is the deprecated path for that older history: **the original Morgan Stanley
onboarding**, kept only so history older than the feed can still be
imported. It is not maintained for new institutions -- do not use it as a
template for a bank the feed does not already cover.

1. **Download statements** with the legacy adapter, for one institution at a
   time. `adapter-morgan-stanley` is the shipped example: a person signs in
   by hand in an ordinary Chrome window, and the adapter reads through that
   already-signed-in tab. See
   [`packages/adapter-morgan-stanley/README.md`](../packages/adapter-morgan-stanley/README.md).
2. **Run the legacy finance-archive parser and adapters** -- the operator
   command in [`packages/finance-archive`](../packages/finance-archive):

   ```sh
   pnpm --filter @repo/finance-archive build
   node packages/finance-archive/dist/run.js \
     --adapter <module path> --session <module path> --selection <json file>
   # or: pnpm --filter @repo/finance-archive import
   ```

   This prints `DEPRECATED: statement import is the optional history path;
   see docs/onboarding.md` on stderr every time it runs, as a reminder that
   this is the old path, not the current one.
3. **Import the archive into the same ledger the feed writes to:**

   ```sh
   node packages/plaid-feed/dist/cli.js import-archive
   # or: kith-plaid-feed import-archive
   ```

   This is idempotent and safe to rerun. It matches archive accounts onto
   feed accounts automatically (by holdings overlap, then balance, then mask,
   then name), and only imports archive rows strictly before the earliest
   date the feed already covers, so history and the daily feed never
   duplicate coverage.
4. **Pair accounts manually when masks differ.** When automatic matching
   cannot find a confident pair, use `--link`:

   ```sh
   node packages/plaid-feed/dist/cli.js import-archive --link ARCHIVE_ACCOUNT_ID=PLAID_ACCOUNT_ID
   ```

   This persists and is never overridden by a later automatic match; `--unlink`
   reverses it. See the plaid-feed README's "Account matching" section for
   the full matching order.

## Daily operation

| What | When | Where |
| --- | --- | --- |
| `kith-plaid-feed pull` | Daily, via LaunchAgent (`StartCalendarInterval`, example at 6 AM). | Logs at the `StandardOutPath`/`StandardErrorPath` the plist names; exits non-zero on any item failure. |
| `kith-ingest-simple` | Hourly, via LaunchAgent (`StartInterval`, 3600 seconds). | Same pattern: logs at the plist's `StandardOutPath`/`StandardErrorPath`. |
| `kith-deferred-work tick` | Every minute, on the always-on daemon host. | See [`docs/worker-service.md`](worker-service.md), "Deferred work daemon". |

Check the result in the web app: the Balances page (`/admin/balances`) and
the Institutions page (`/admin/institutions`) show current values with the
date they were fetched. Over MCP, `list_ledger` and `list_holdings` expose
the same unified ledger to a connected assistant.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Plaid calls fail with `INVALID_API_KEYS` | The client ID/secret pair does not match `PLAID_ENV`. A Trial plan only runs in `production`; if a Sandbox secret was stored in the `com.kithmind.plaid.secret` Keychain item (or `PLAID_SECRET`), replace it with the Production secret. |
| A backfill or ingest run reports `could not serialize access due to read/write dependencies among transactions` | `--backfill-embeddings` (or a manual `kith-ingest-simple` run) overlapped with the hourly ingest LaunchAgent against the same account. Both packages retry a serialization conflict automatically (up to three attempts, per file); a run that still fails after retrying should not be run at the same time as the hourly schedule. |
| `pull` reports `ITEM_LOGIN_REQUIRED` for an institution | The bank ended Plaid's session for that item (common after a password change or a periodic re-auth requirement). Re-run `kith-plaid-feed link` for that institution; `pull` does not retry this on its own and sets `needs_relink_at` on the item. |
