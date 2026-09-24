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
| Health | Structured records (labs, conditions, medications, immunizations, encounters and more) from Epic's patient-facing FHIR API, one authorization per person, shown on the Health Records admin page and readable by MCP tools. See "Health records with Epic MyChart" below. |

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

[`packages/epic-feed`](../packages/epic-feed) pulls structured health records
(labs, conditions, medications, immunizations, encounters and more) from any
Epic health system's patient-facing FHIR API: one SMART on FHIR
authorization per person, one authorization per health system that person
uses. This section is an agent-drivable runbook -- every step is marked
**person** (a browser action only a human can do) or **agent** (a command
the agent runs), with the exact field values used. See
[its README](../packages/epic-feed/README.md) for the `authorize`, `pull`,
and `check` commands in full detail; this is the setup path.

### Which health systems can I connect?

Any patient portal whose sign-in page says **MyChart** is built on Epic and
is supported -- the same one registered app works against every Epic
organization once each organization activates it. A portal's own branding
often differs from the legal name Epic's directory uses for that
organization (for example, a hospital system's own MyChart login page may
not use the name Epic lists it under). To find the right name, search
Epic's public R4 endpoint directory
([`https://open.epic.com/Endpoints/R4`](https://open.epic.com/Endpoints/R4))
for the portal's own hostname or a recognizable fragment of its name, or ask
the agent to do that search. Patient portals that are **not** MyChart use a
different, unimplemented API and are not supported yet.

### Register the app (once, not per health system)

1. **person.** Sign in (or create an account) at
   [fhir.epic.com](https://fhir.epic.com) and start a new app registration.
2. **person.** Set **Application Audience** to `Patients`.
3. **person.** Set **Automatic Client Distribution** to `USCDI v3`. This is
   what lets any Epic organization activate the app on its own, without a
   manual per-organization approval from Epic.
4. **person.** Under **Incoming APIs**, select R4 Read and Search for
   exactly: Patient, Observation (Labs, Vitals, Social History),
   DiagnosticReport, Condition, MedicationRequest, AllergyIntolerance,
   Immunization, Encounter, Procedure, DocumentReference (Clinical Notes),
   Binary (Clinical Notes), Goal. Skip Specimen, DSTU2, STU3, Create, and
   Premium Billing.
5. **person.** Set **Endpoint URI** to the app's https callback only:
   `https://<your host>/api/epic/callback`. Epic's sandbox rejected
   `http://localhost` here; only the https form worked.
6. **person.** Leave **Can Register Dynamic Clients** unchecked. Check **Is
   Confidential Client**. Check **Requires Persistent Access** -- without
   it, Epic drops the `offline_access` scope and issues no refresh token at
   all (learned by omitting it once and having to register a new app, since
   Epic locks an app's configuration once it reaches production). Leave
   **Uses Rolling Refresh Tokens** unchecked -- the code handles rotation
   itself, but a non-rolling token survives an interrupted pull. Leave
   **JWK Set URLs** blank.
7. **person.** Under **Sandbox Client Secret**, click **Generate Secret**,
   copy the value immediately (it is shown once), then click **Store
   Hash**.
8. **person.** Set the protocol to **SMART on FHIR R4**, scopes to **SMART
   v1 scopes**, and FHIR IDs to **Unconstrained FHIR IDs**.
9. **person.** Set **Intended Purposes** to only "Individuals' Access to
   their EHI" and **Intended Users** to only "Individual/Caregiver".
10. **person.** Set the **Terms and Conditions URL** to this repository's
    terms page (`docs/terms.md`), e.g.
    `https://github.com/<org>/<repo>/blob/main/docs/terms.md`.
11. **person.** Answer the **Data Use Questionnaire** truthfully: the data
    is not sold, not shared with third parties, stays under the user's
    control, and access is revocable at any time from within MyChart.
12. **person.** Accept the terms and click **Save**.
13. **person.** Click **Ready for Sandbox**. Note both client IDs the app's
    page now shows -- one for the sandbox (non-production) environment and
    one for production. Client IDs are public values, not secrets, but
    record them: they are what step 14 below stores.

### Store the credentials

Do this on the machine that will run `authorize` and `pull` -- the Keychain
items live there, not in the repository.

| Keychain item | Holds |
| --- | --- |
| `com.kithmind.epic.client-id` | This app's production client id. |
| `com.kithmind.epic.client-id-nonprod` | This app's sandbox (non-production) client id. |
| `com.kithmind.epic.client-secret` | A shared client secret, used for any organization with no secret of its own (and for the sandbox). |
| `com.kithmind.epic.client-secret.<org-slug>` | One organization's own client secret (recommended per organization, and required for that organization's refresh tokens -- see step 26). `<org-slug>` is the organization's name, lowercased with runs of non-alphanumeric characters collapsed to one hyphen, e.g. `Virginia Mason Franciscan Health` -> `virginia-mason-franciscan-health`. |
| `com.kithmind.epic.token.<person-slug>.<org-slug>` | Written by `authorize`, read and rewritten by `pull` -- not something to add by hand. |

14. **agent.** Store each item with `security add-generic-password`, argv
    form (never a shell string the secret could leak through):

    ```sh
    security add-generic-password -U -a "$USER" -s <item-name> -w <value>
    ```

    If macOS answers `SecKeychainItemCreateFromContent: User interaction is
    not allowed`, the login keychain is locked in this session; unlock it
    first and retry:

    ```sh
    security unlock-keychain ~/Library/Keychains/login.keychain-db
    ```

### Prove it works in the sandbox

15. **agent.** Build the package once:

    ```sh
    pnpm --filter @repo/epic-feed build
    ```

16. **agent.** Run, for a synthetic or test person entity:

    ```sh
    node packages/epic-feed/dist/cli.js authorize --person <id-or-name> --sandbox
    # or, once installed as a bin: kith-epic-feed authorize --person <id-or-name> --sandbox
    ```

    This prints an authorization URL.
17. **person.** Open the printed URL and sign in as one of
    [Epic's own published sandbox test patients](https://fhir.epic.com/Documentation?docId=testpatients)
    (the username commonly used is `fhircamila`; use the password Epic's own
    page publishes there -- never invent or guess one, only that page's
    values work against the sandbox). Approve access.
18. **person.** Paste the code the callback page shows back into the
    terminal `authorize` is waiting in.
19. **agent.** Confirm the line `Authorized as confidential client; refresh
    token: present`. `absent` here means step 6's Requires Persistent
    Access checkbox was missed -- see Troubleshooting below.
20. **agent.** Run:

    ```sh
    node packages/epic-feed/dist/cli.js pull
    ```

    and confirm counts print for `Patient` and a few other resource types.
21. **agent.** Delete the sandbox source afterward, so Epic's synthetic test
    data does not stay attached to a real person entity. There is no CLI
    command for this yet, so delete directly: the row's `ON DELETE CASCADE`
    (`packages/kith-store/migrations/053_health_feed.sql`) takes its
    `health_records` and `health_documents` rows with it.

    ```sh
    psql "$DATABASE_URL" -c "DELETE FROM kith.health_sources WHERE fhir_base = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/'"
    security delete-generic-password -a "$USER" -s com.kithmind.epic.token.<person-slug>.epic-sandbox
    ```

### Go to production

22. **person.** On the app's page at fhir.epic.com, click **Ready for
    Production**.
23. **person.** Open the app's Manage keys page
    (`fhir.epic.com/Developer/Management?id=<app>`). For each health system
    to connect, search for it by Epic's own directory name (see "Which
    health systems can I connect?" above), then activate it twice, in this
    order -- Epic requires Non-Production activation before Production:
    1. **Activate for Non-Production**, with **Use app-level endpoint
       URIs** and authentication **Other**, then **Client Secret**.
    2. **Activate for Production**, with the same two settings.
24. **agent.** Store that organization's production secret under its own
    Keychain item (`com.kithmind.epic.client-secret.<org-slug>`, step 14's
    form).
25. **agent.** Run `check` until it reports the client is known there --
    Epic says activation can take up to a day, and organizations sync it on
    their own schedule:

    ```sh
    node packages/epic-feed/dist/cli.js check --org "<Epic directory name>"
    ```

26. **agent.** Once `check` reports the client known, authorize each person
    at that organization:

    ```sh
    node packages/epic-feed/dist/cli.js authorize --person <id-or-name> --org "<Epic directory name>"
    ```

27. **person.** When authorizing a family member, choose them in MyChart's
    own proxy picker during sign-in (see "Family members" below).
28. **agent.** Run `pull` (same command as step 20) to confirm the new
    source comes back with counts.
29. **agent.** Schedule `pull` daily with a LaunchAgent. Copy
    [`com.kithmind.epic-feed.plist.example`](../packages/epic-feed/com.kithmind.epic-feed.plist.example)
    into a real `.plist` under `~/Library/LaunchAgents/`, replace every
    `ABSOLUTE/PATH/...` placeholder, and `launchctl load` it -- see the
    README's "LaunchAgent (daily pull at 06:30)" section.

### Family members

Each family member is a person entity in Kith Mind. Connecting them needs
one authorization per person per health system (step 26), and requires that
the account holder already has that family member's proxy access set up in
MyChart -- Epic's own mechanism, not anything this package implements. There
is no household-wide authorization.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `error=4 The request is invalid` at OAuth/Start | The redirect URI Epic has on file for this app does not match the one `authorize` sent. Confirm step 5's Endpoint URI matches `EPIC_REDIRECT_URI` (or the built-in default) exactly. |
| `genericloginfailed` on the sandbox login page | Developer credentials were used instead of a published test patient. Sign in as one of [Epic's own test patients](https://fhir.epic.com/Documentation?docId=testpatients) (step 17), not the fhir.epic.com developer account. |
| `invalid_client` at the token exchange | Either the secret is not stored or hashed correctly, or this organization has not yet distributed the client ID (production activation can take up to a day). Run `check --org "<name>"` (step 25) for a precise diagnosis without guessing. |
| `refresh token: absent` after `authorize` | Step 6's **Requires Persistent Access** was not checked at app registration. This cannot be fixed by re-saving the existing app -- Epic locks a production app's configuration, so register a new app with that box checked and repeat registration. |
| An `Observation` search returns nothing, or `Specimen` always fails | Expected: Epic requires a `category` parameter for `Observation` searches (handled -- `pull` searches once per registered category), and Epic does not support `Specimen` for patient-facing access (handled -- treated as unsupported, not a resource error). |

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
