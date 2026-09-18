# Self-hosting Kith Mind

This runbook describes the currently implemented account-isolated application.
Family spaces, bounded inline capture, source records, and durable processing
primitives are implemented. A bounded filesystem text worker supports foreground
polling; use the [synthetic worker recipe](filesystem-worker.md) after deployment
setup. Check prerequisites with [worker doctor](worker-doctor.md) and use the
[optional user-service recipes](worker-service.md) for local supervision.
Additional connectors, full operational recovery, and bulk ingestion
remain Phase 2 work. Desktop is primary; native mobile
integration is P2 and is not a setup gate.

Prerequisites are Node.js 22 or newer and pnpm 10.20 (the repository pins this
package-manager version). No private tracker, owner account, or private file is
needed for a public-clone setup.

This runbook is for a small personal deployment shared by a few independent
accounts. It keeps the operational surface deliberately narrow: one Convex
project, one Next.js/Vercel project, and one set of server-side AI provider
credentials. Each person still creates a separate Kith Mind account and
authorizes their own MCP client.

The deployment can fit within hosted free tiers at low usage, but it is not
guaranteed to be completely free. OpenAI embeddings and Anthropic memory
analysis are metered API calls. Connecting a ChatGPT or Claude
consumer account does not provide or pay for those backend API calls. Qdrant is
not required because Convex already stores and searches the vectors.

## Stop point before deployment

Repository setup and all local tests can be completed without accounts or
credentials. The first actions that require external access are:

- creating or selecting Convex and Vercel projects;
- creating OpenAI and Anthropic API keys;
- setting production environment variables;
- deploying Convex or Vercel; and
- connecting ChatGPT and Claude accounts.

Do not paste credentials into an issue, pull request, chat, shell command, or
tracked file. Use the provider dashboards or an interactive CLI prompt.

## Configuration map

| Variable                              | Location          | Purpose                                                               |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `MCP_PUBLIC_ORIGIN`                   | Vercel only       | Stable HTTPS origin of the Next.js gateway, no path or trailing slash |
| `MCP_JWT_ISSUER`                      | Convex only       | Convex Auth's own issuer; the web app stopped reading it in i7b       |
| `MCP_OAUTH_ENCRYPTION_KEY`            | Vercel only       | Encrypts OAuth registrations and authorization codes; secret          |
| `MCP_TOOL_PROFILE`                    | Vercel only       | `full` by default; `memory` is an optional narrower runtime profile   |
| `FINANCE_ARCHIVE_READER_DATABASE_URL` | Vercel only       | Optional; the financial archive as its read-only reader role; secret  |
| `FINANCE_ARCHIVE_SPACE_ID`            | Vercel only       | Optional; the one space that archive holds; required with the URL     |
| `OPENAI_API_KEY`                      | Convex only       | Creates embeddings; secret and billed to the self-host                |
| `ANTHROPIC_API_KEY`                   | Convex only       | Extracts and classifies memories; secret and billed to the self-host  |
| `SITE_URL`                            | Convex only       | Stable HTTPS origin of the Next.js app used by Convex Auth            |
| `JWT_PRIVATE_KEY`                     | Convex only       | Signs Convex Auth session tokens; generated secret                    |
| `JWKS`                                | Convex only       | Public key set used to verify Convex Auth session tokens              |

Bounded inline text capture, retained evidence, and keyword search work without
provider calls. Anthropic is optional for narrative classification and metadata
extraction, and OpenAI is optional for semantic embeddings. Provider-backed
features add those external calls and costs; they are not required to verify
the core capture and family-space workflow.

`CONVEX_SITE_URL` is supplied by Convex and should not be created manually.
`CONVEX_DEPLOYMENT` is local Convex CLI linkage, not an application secret and
not a Convex backend environment variable. Convex backend variables are scoped
to a Convex deployment and are not sourced from the Next.js `.env.local` file.

Platform references:

- [Convex environment variables](https://docs.convex.dev/production/environment-variables)
- [Convex environment CLI](https://docs.convex.dev/cli/reference/env)
- [Convex deployment CLI](https://docs.convex.dev/cli/reference/deploy)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)

Reference templates live at
[`apps/web/.env.example`](../apps/web/.env.example). Create provider keys in
the provider dashboards only when enabling their optional features. Set them
through the interactive Convex CLI, which avoids placing a secret in shell
history or a tracked file:

```sh
pnpm --filter @repo/db exec convex env --prod set OPENAI_API_KEY
pnpm --filter @repo/db exec convex env --prod set ANTHROPIC_API_KEY
```

## The web deployment's variables

Row m flipped production to the PostgreSQL surface and i7b removed Convex from
`apps/web` entirely, so there is one surface and one list. `packages/convex`
is still in the tree and its own variables above are still set until the
Convex deployment is torn down; nothing in the web app reads it.

The list below is derived from `apps/web/src/lib/mcp/environment.ts`
(`requiredMcpEnvironmentVariables`, `validateMcpEnvironment`) and from every
`process.env` read under `apps/web/src` and `packages/kith-store/src`, not
guessed. "Set where" is `Vercel` (the web deployment's environment), `Daemon`
(the always-on worker host that runs `kith-deferred-work`), or `Both`.

| Variable                              | Read by                                                                                                                                        | Set where | Required                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KITH_DATABASE_URL`                   | `lib/kith/pool.ts`                                                                                                                             | Vercel    | Required. The app role's connection string, not the migration role's -- `createKithPool` pins two connections and `search_path`, and the app role only has the grants `packages/kith-store/src/index.ts`'s `grantProofAppRole` names. `docs/plans/2026-09-16-cutover-runbook.md` says how that role is provisioned: `.github/workflows/cutover.yml` creates or updates it from the `app_role` input and the `KITH_APP_ROLE_PASSWORD` secret |
| `KITH_SESSION_SECRET`                 | `lib/kith/session.ts`                                                                                                                          | Vercel    | Required; at least 32 characters, no default -- a missing one is a loud 500, never a silently shared signing key                                                                                                                                                                                                                                                                                                                            |
| `MCP_PUBLIC_ORIGIN`                   | `lib/mcp/environment.ts` (`getMcpPublicOrigin`)                                                                                                | Vercel    | Required. The origin this gateway is published at, used by the `WWW-Authenticate` resource metadata URL, the OAuth metadata documents and the resource identifier                                                                                                                                                                                                                                                                                            |
| `MCP_OAUTH_ENCRYPTION_KEY`            | `lib/mcp/oauth.ts`                                                                                                                             | Vercel    | Required; unchanged from the Convex era                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MCP_TOOL_PROFILE`                    | `lib/mcp/tool-policy.ts`                                                                                                                       | Vercel    | Optional; `full` by default, `memory` narrows the runtime tool set                                                                                                                                                                                                                                                                                                                                                                                           |
| `FINANCE_ARCHIVE_READER_DATABASE_URL` | `lib/mcp/finance.ts`                                                                                                                           | Vercel    | Optional; the financial archive as its reader role, unchanged from the Convex era                                                                                                                                                                                                                                                                                                                                                                            |
| `FINANCE_ARCHIVE_SPACE_ID`            | `lib/mcp/finance.ts`                                                                                                                           | Vercel    | Optional; required together with the URL above                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FINANCE_ARCHIVE_CURSOR_SECRET`       | `lib/mcp/finance.ts`                                                                                                                           | Vercel    | Optional; required together with the URL above -- at least 32 bytes, signs the archive's paging continuations                                                                                                                                                                                                                                                                                                                                                |
| `BRAIN_EMBED_API_KEY`                 | `packages/kith-store/src/embeddings/provider.ts` (`loadEmbeddingConfig`), reached through `lib/mcp/embedder.ts`'s shared seam                  | Both      | Optional; takes precedence over `OPENAI_API_KEY` when set; on the daemon host it is what `embedding_fill` jobs use                                                                                                                                                                                                                                                                                                                                           |
| `OPENAI_API_KEY`                      | Same, via `lib/mcp/embedder.ts`                                                                                                                | Both      | Optional; the default embedding key when `BRAIN_EMBED_ENDPOINT` is unset or is still the default OpenAI endpoint; on the daemon host it is what `embedding_fill` jobs use                                                                                                                                                                                                                                                                                    |
| `BRAIN_EMBED_ENDPOINT`                | Same                                                                                                                                           | Vercel    | Optional; a custom endpoint requires `BRAIN_EMBED_PROVIDER_ID` and `BRAIN_EMBED_MODEL_REVISION` together with it                                                                                                                                                                                                                                                                                                                                             |
| `BRAIN_EMBED_PROVIDER_ID`             | Same                                                                                                                                           | Vercel    | Required together with `BRAIN_EMBED_ENDPOINT`; otherwise optional                                                                                                                                                                                                                                                                                                                                                                                            |
| `BRAIN_EMBED_MODEL`                   | Same                                                                                                                                           | Vercel    | Optional; selects a compatible model                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BRAIN_EMBED_MODEL_REVISION`          | Same                                                                                                                                           | Vercel    | Required together with `BRAIN_EMBED_ENDPOINT`; otherwise optional                                                                                                                                                                                                                                                                                                                                                                                            |
| `BRAIN_EMBED_DIMENSIONS`              | Same                                                                                                                                           | Vercel    | Optional; must be `1536` for the current vector index when set                                                                                                                                                                                                                                                                                                                                                                                               |
| `ANTHROPIC_API_KEY`                   | `packages/kith-store/src/memory/captureClassifier.ts` (`loadCaptureClassifierConfig`), reached through `lib/kith/capture.ts`'s classifier seam | Vercel    | Optional; see below                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KITH_STORE_DATABASE_URL`             | `packages/kith-store/src/deferred/cli.ts` (`kith-deferred-work`)                                                                               | Daemon    | Required for the daemon. A broader-privilege connection string than `KITH_DATABASE_URL`: the daemon and the migration tooling use it, the web app's narrower app role never does                                                                                                                                                                                                                                                                             |

The embedding provider row is read by the three vector-backed MCP read tools
(`search_documents`, `search_thoughts`, `recall_context`) and by narrative
capture's admission gate, all through `lib/mcp/embedder.ts`'s
`resolveMcpEmbedder` -- one seam, since i7a unified `lib/kith/capture.ts`'s
own embedder into it. `lib/mcp/reads.ts` calls it before opening a
transaction for a search; the gate calls it the same way, between its first
and second transaction, and only when the destination space's thought index
is complete enough to search (`lib/kith/capture.ts`'s module comment,
"indexReady"). Keyword search still works with none of the
`BRAIN_EMBED_*`/`OPENAI_API_KEY` rows set; a capture whose destination has no
complete index also never reaches the embedder, by design, not as a
degradation.

`ANTHROPIC_API_KEY` on this row is the _web_ deployment's key, distinct from
the Convex deployment's row of the same name earlier in this document.
Narrative capture's admission gate (`lib/kith/capture.ts`'s
`captureThoughtFromWeb`, shared by the MCP `capture_thought` tool and the
dashboard's Quick Capture button) runs on the web deployment and reads this
one. Optional in the sense this document already uses for the Convex key: the
gate fails closed without it, so a `capture_thought` call or a Quick Capture
submission returns `needs_confirmation` ("Memory was not stored because the
admission check was unavailable") and stores nothing, rather than storing
unclassified. Provider-free inline capture and keyword search remain
unaffected. Setting the key only on the Convex deployment does not enable
narrative capture; it has to be set on Vercel.

### Removed by i7b

`NEXT_PUBLIC_CONVEX_URL`, `MCP_JWT_PRIVATE_JWK`, `MCP_JWT_PUBLIC_JWK` and
`MCP_JWT_KEY_ID` are gone from the web deployment with the last Convex import
and the JWT bridge that minted identity tokens from them. `MCP_JWT_ISSUER` on
the _web_ deployment is gone too; `MCP_PUBLIC_ORIGIN` is the name for that
value. Setting any of the five changes nothing and the preflight no longer
reports them, in either direction. `MCP_JWT_ISSUER` on the _Convex_
deployment is a different variable and stays until that deployment is torn
down.

### The daemon host: `kith-deferred-work`

`kith-deferred-work` is the command `packages/kith-store/src/deferred/cli.ts`
builds, run on the always-on worker host rather than as a cloud cron -- the
same host that already runs the filesystem worker and an installed daily
backup service, per section 2.6 of the [PostgreSQL consolidation
plan](plans/2026-09-12-postgres-consolidation.md) (row j replaces four Convex
crons with it). It has three modes:

```sh
kith-deferred-work once
kith-deferred-work tick [--interval-ms N]
kith-deferred-work drain [--interval-ms N] [--max-jobs N]
```

The daemon reads `KITH_STORE_DATABASE_URL` (required, no default) and, for
`embedding_fill` jobs, the same embedding provider variables the web deployment
reads: the `BRAIN_EMBED_*` set or `OPENAI_API_KEY`, set independently on the
daemon host because the two processes share no environment. See the embedding
provider configuration table above. `docs/kithmind-deferred-work.launchd.plist.txt`
is the per-user LaunchAgent template: a private wrapper script (not the
checked-in plist) exports these variables from Keychain items, the same pattern
`docs/worker-service.md`'s filesystem-worker wrapper uses for its own credential,
and execs `kith-deferred-work tick --interval-ms 60000` -- matching the
per-minute cadence of the two Convex crons this daemon replaces that ran that often.

The `embedding_fill` deferred-work handler is wired in `packages/kith-store/src/deferred/cli.ts`
and `packages/kith-store/src/deferred/registry.ts`. A daemon with the embedding provider
unset still starts and runs every sweep; only `embedding_fill` jobs fail in that case,
without leaking the key or provider message.

## 1. Prepare the fork locally

Install and verify the repository before connecting any hosted service:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

For local development, link `packages/convex` to a development deployment and
run Convex once to publish the generated client types and local URL:

```sh
cd packages/convex
npx convex dev --once
cd ../..
```

Configure Convex Auth for the local web origin, preserving the repository's
existing auth provider configuration:

```sh
pnpm --filter @repo/db exec auth --web-server-url http://localhost:3000
```

Copy `apps/web/.env.example` to the ignored `apps/web/.env.local`, fill in the
development values, and run `pnpm dev`. `MCP_PUBLIC_ORIGIN` may be
`http://localhost:3000` locally; anywhere else it has to be HTTPS.

Never fill in or commit the example file.

## 2. Create and configure Convex

Create a Convex project for the fork and link `packages/convex` to it. The
provider-free core configuration does not require `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`; add either key only when enabling its optional semantic
or narrative feature. Once the stable Vercel origin is known, configure Convex
Auth using its official setup command:

```sh
pnpm --filter @repo/db exec auth --prod --web-server-url https://your-project.vercel.app
```

This sets `SITE_URL` and generates a matched `JWT_PRIVATE_KEY`/`JWKS` pair on
the production Convex deployment. Treat the private key as a secret. The CLI
preserves configured custom providers and may offer auth-template suggestions;
do not replace an existing provider configuration unless that is intentional.
If either key variable already exists, the command asks before rotating it;
routine rotation is unnecessary and signs out existing sessions.

Set the separate MCP issuer to the same stable origin:

```sh
pnpm --filter @repo/db exec convex env --prod set MCP_JWT_ISSUER
```

Enter the final stable Vercel origin for `MCP_JWT_ISSUER`, for example
`https://your-project.vercel.app`, with no path or trailing slash. This is the
Convex deployment's own variable; the web deployment spells the same origin
`MCP_PUBLIC_ORIGIN`. Do not deploy until the Convex names pass
the production preflight and any optional provider variables needed by enabled
features are set. Deploying Convex is a production action;
perform it only after reviewing the target project:

```sh
pnpm --filter @repo/db deploy:prod
```

## 3. Create and configure Vercel

Import the fork as a new Vercel project with `apps/web` as the Vercel Root
Directory and Next.js as the Framework Preset. Vercel still installs workspace
dependencies from the pnpm monorepo; pointing the project at the repository
root instead leaves the project on the generic framework preset and does not
identify the web app's build output. Use a stable production domain before
setting the issuer. Configure all of these for Production; use separate Preview
values if preview deployments need a working OAuth flow:

- `MCP_PUBLIC_ORIGIN`
- `KITH_DATABASE_URL`
- `KITH_SESSION_SECRET`
- `MCP_OAUTH_ENCRYPTION_KEY`
- `MCP_TOOL_PROFILE` (optional; defaults to `full`)
- `FINANCE_ARCHIVE_READER_DATABASE_URL` (optional; see below)
- `FINANCE_ARCHIVE_SPACE_ID` (optional; required together with the URL)

The last two enable the financial archive as a provider behind `query_records`
and `list_sources`. Set them only if you run the archive. Point the URL at the
archive as the reader role created by `applyPgReaderRole`, never as its owner,
and set the space id to the one space that archive holds. With either value
missing the provider stays off and a finance query is refused explicitly rather
than answered empty. The connection string is a secret and never enters the
repository.

Generate the OAuth encryption key and the session secret once on a trusted
local machine, 32 random bytes each, and paste them straight into the Vercel
dashboard rather than through terminal history or logs:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

No `NEXT_PUBLIC_` variable is needed by this deployment, and nothing here may
be exposed through one.

Do not rotate these values as routine maintenance for this personal
deployment. Rotating the OAuth encryption key invalidates existing client
registrations and requires each MCP client to reconnect. Rotating
`KITH_SESSION_SECRET` signs every browser session out.

## 4. Run the safe preflight

The web preflight reads the ignored `apps/web/.env.local` by default. It checks
origins, P-256 key shape and pairing, the OAuth key shape, and required names.
Its output contains variable names only, never values:

```sh
pnpm check:self-hosting
```

`core` and `full` are preflight profiles, not runtime MCP tool profiles. Use
`pnpm check:self-hosting -- --profile core` to validate a provider-free core
deployment or `pnpm check:self-hosting -- --profile full` for the default full
provider check. Core omits provider keys only; gateway authentication and
Convex Auth settings remain required. At runtime, `MCP_TOOL_PROFILE` is
separately `memory` or `full`. When selecting a custom web environment file,
use the preflight's `--web-env-file` option.

The Convex preflight asks the Convex CLI for environment variable names only;
it never requests their values:

```sh
pnpm check:self-hosting:convex
```

For a provider-free production Convex preflight, use:

```sh
pnpm check:self-hosting:convex -- --profile core
```

To check a non-production Convex deployment, run:

```sh
node scripts/check-self-hosting.mjs --convex --deployment dev
```

After deployment, the public health endpoint returns HTTP 503 with missing or
invalid variable names if the Next.js gateway is misconfigured. It never
returns configured values:

```sh
curl --fail-with-body https://your-ai-brain.example.com/api/mcp/health
```

## 5. Create the first account and connect MCP

1. Open the deployed web application and create the primary account.
2. Connect a hosted MCP client to
   `https://your-ai-brain.example.com/api/mcp` and complete OAuth while signed
   in as that account.
3. Grant the client Personal-space `read` permission first. Add broader
   permissions only when a later workflow needs them.

The optional server-side OpenAI and Anthropic credentials serve the account.
Those provider keys are not exposed to the user or MCP client.

### Optional family-space verification

If a second account and shared family space are needed, create the second
account in a separate browser profile. Keep each account's direct MCP key
separate. Use **Spaces** in the first account to create a shared space and
invite the second account. Copy the secret invite link immediately; it expires
after seven days. The second account accepts the link and the first account
approves the accepted account. Create one person record per synthetic member
and explicitly link each member. Verify shared access, Personal-space
isolation, Reader and Editor permissions, ownership transfer, and member
removal. The last owner cannot be removed or leave.

In **Settings**, add a synthetic MCP client source to the shared space, then
generate a temporary key with `read` and `ingest`, granting that shared space
and the configured source account. Confirm a key without the source-account
grant cannot ingest, and that a Reader-scoped key cannot write. Source setup
records identity and scope; it does not poll a connector.

## 6. Verify behavior before relying on it

The provider-free synthetic smoke test is available as:

```sh
pnpm demo:brain
```

Create an ignored `.env.demo.local` in the repository root with these four
names, using a dedicated synthetic space and source:

```text
KITHMIND_URL=
KITHMIND_API_KEY=
KITHMIND_SPACE_ID=
KITHMIND_SOURCE_ACCOUNT_ID=
```

`KITHMIND_SOURCE_ACCOUNT_ID` is the configured source `accountId` identity
string, not a Convex row ID. Load the ignored file before starting the script:

```sh
node --env-file=.env.demo.local scripts/demo-brain.mjs
```

Use synthetic data and a reachable HTTPS origin, or explicit loopback HTTP for
local development. The demo posts two labeled fixtures, a synthetic vehicle
service note and a synthetic lab note, and repeats them to check idempotency.
It then uses `search_documents` with explicit
`searchMode: "keyword"` and `get_document` to verify retained Unicode
evidence. It does not call OpenAI or Anthropic and does not claim typed
extraction or connector polling. The documents remain as labeled synthetic
fixtures on rerun; revoke the temporary API key after the check. The exact
request and processing limits are in the [bounded text capture
contract](plans/2026-09-06-inline-ingestion-contract.md). Larger documents,
real connector polling, and typed extraction remain Phase 2 work.

Use harmless synthetic facts first. Complete these checks in both accounts:

1. Capture a durable fact and retrieve it with different wording.
2. Capture a changed fact; confirm normal search returns the new current fact
   and historical search returns the former fact as superseded.
3. Correct an inaccurate fact; confirm the bad fact is retracted rather than
   represented as formerly true.
4. Repeat a fact; confirm capture does not create a duplicate current memory.
5. Search for the other account's distinctive synthetic fact; confirm there
   are no results.
6. Optionally, in both ChatGPT and Claude, state a durable project update
   without saying “remember this”; confirm the client calls capture
   automatically. This client behavior is not a core installation gate.
7. Optionally, start a later conversation and ask about the project; confirm
   the client invokes recall and uses the current fact.

Automatic capture remains client-mediated. The MCP server can strongly
describe when its tools should be used, but it cannot observe a ChatGPT or
Claude conversation unless that client calls the tool. A database replacement
would not change this limitation.

## Personal-operation policy

Treat Convex data as durable. Before any real-data or bulk-ingestion work,
complete the Phase 2 recovery gate, including backup/export and restore into
an isolated deployment. Code rollback does not roll back memory transitions.

Keep routine operations minimal:

- do not rotate keys unless one is exposed;
- do not add Elasticsearch, Qdrant, a reranker, or another model until the
  retrieval evaluation shows a concrete need;
- review provider usage occasionally for unexpected spend; and
- rerun both preflights after changing a domain, project, or credential.

For a pre-production Vercel check, specify the target on both commands instead
of relying on the CLI default:

```sh
vercel build --target preview
vercel deploy --prebuilt --target preview
```

Review the reported target before treating the result as a preview. A
production deployment can claim the stable project aliases immediately, even
when its build artifacts were created with Preview-scoped variables.

## Common failures

| Symptom                                      | Check                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Health endpoint returns 503                  | Fix only the variable names listed in `issues`                                                                           |
| OAuth metadata has the wrong host            | Make `MCP_PUBLIC_ORIGIN` the final stable HTTPS origin and redeploy Vercel                                               |
| AI-assisted capture or semantic search fails | Confirm provider variables and embedding configuration; provider-free inline capture and keyword search remain available |
| Core capture or gateway calls fail           | Confirm Convex Auth/JWKS settings, MCP issuer, API-key capability, and current space membership                          |
| Account creation fails after saving a user   | Confirm `SITE_URL`, `JWT_PRIVATE_KEY`, and `JWKS` exist on the production Convex deployment                              |
| Clients must authorize again unexpectedly    | Check whether `MCP_OAUTH_ENCRYPTION_KEY` changed                                                                         |
| Automatic capture is inconsistent            | Verify the client enabled the MCP server and inspect whether it called `remember_fact` or `capture_thought`              |
| Bootstrap creates broad or noisy memories    | Update/reinstall the bundled plugin, rerun `/brain-init`, and approve only the atomic preview                            |

## Embedding provider configuration

Configure embeddings on the Convex backend. The default remains OpenAI
`text-embedding-3-small` with 1,536 dimensions and `OPENAI_API_KEY`. Optional
`BRAIN_EMBED_API_KEY` takes precedence. A custom `BRAIN_EMBED_ENDPOINT` requires
explicit `BRAIN_EMBED_PROVIDER_ID` and `BRAIN_EMBED_MODEL_REVISION`; it never
receives the default OpenAI key. `BRAIN_EMBED_MODEL` can select a compatible
model and `BRAIN_EMBED_DIMENSIONS` must be `1536` for the current index.

Changing identity requires a complete staged embedding generation before
activation. Existing spaces need the baseline migration before canonical
semantic recall can use their existing vectors. Keyword reads remain available
when the provider or profile is unavailable. See the
[embedding contract](plans/2026-09-06-embedding-contract.md) for migration,
operator rebuild commands, limitations, and credential handling.

## OAuth lifecycle maintenance

Unfinished OAuth grants expire automatically after five minutes. The cleanup job runs in bounded batches. Existing active credentials remain valid across this lifecycle upgrade. A client with an authorization already in progress during deployment may need to start again.

Use the [OAuth lifecycle audit](plans/2026-09-07-oauth-lifecycle.md#deployment-and-audit) to check stored grants after deployment. Settings paginates active credentials and supports revocation from every page.
