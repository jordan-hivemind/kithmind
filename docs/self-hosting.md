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
| `NEXT_PUBLIC_CONVEX_URL`              | Vercel/Next.js    | Public Convex client origin; intentionally browser-visible            |
| `MCP_JWT_ISSUER`                      | Vercel and Convex | Stable HTTPS origin of the Next.js gateway; values must match exactly |
| `MCP_JWT_PRIVATE_JWK`                 | Vercel only       | Signs 60-second Convex identity tokens; secret                        |
| `MCP_JWT_PUBLIC_JWK`                  | Vercel only       | Published through the MCP JWKS endpoint                               |
| `MCP_JWT_KEY_ID`                      | Vercel only       | Optional signing-key identifier; runtime defaults to `mcp-1`          |
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

## The PostgreSQL surface (`KITH_POSTGRES_SURFACE`)

Everything above this section describes the Convex-era deployment, which is
still what a fresh self-host and `main`'s production traffic run. The rest of
this section documents the PostgreSQL surface i7a adds behind
`KITH_POSTGRES_SURFACE=postgres`: it exists in the tree, is exercised by
tests and by preview deployments, and is dark in production until row m of
the web and MCP surface plan flips the flag. Convex is not removed by this
row; `packages/convex` and the variables above stay required. i7b, after the
flip, is what removes them.

The list below is derived from `apps/web/src/lib/mcp/environment.ts`
(`requiredMcpEnvironmentVariables`, `validateMcpEnvironment`) and from every
`process.env` read under `apps/web/src` and `packages/kith-store/src`, not
guessed. "Set where" is `Vercel` (the web deployment's environment), `Daemon`
(the always-on worker host that runs `kith-deferred-work`), or `Both`.

| Variable                              | Read by                                          | Set where | Required                                        |
| -------------------------------------- | ------------------------------------------------- | --------- | ------------------------------------------------ |
| `KITH_POSTGRES_SURFACE`               | `lib/kith/surface.ts`, `lib/mcp/environment.ts`    | Vercel    | Optional; `postgres` selects this surface, anything else (including unset) reads as `convex` |
| `KITH_DATABASE_URL`                   | `lib/kith/pool.ts`                                 | Vercel    | Required under `postgres`. The app role's connection string, not the migration role's -- `createKithPool` pins two connections and `search_path`, and the app role only has the grants `packages/kith-store/src/index.ts`'s `grantProofAppRole` names. `docs/plans/2026-09-16-cutover-runbook.md` says how that role is provisioned: `.github/workflows/cutover.yml` creates or updates it from the `app_role` input and the `KITH_APP_ROLE_PASSWORD` secret |
| `KITH_SESSION_SECRET`                 | `lib/kith/session.ts`                              | Vercel    | Required under `postgres`; at least 32 characters, no default -- a missing one is a loud 500, never a silently shared signing key |
| `MCP_PUBLIC_ORIGIN`                   | `lib/mcp/environment.ts` (`getMcpPublicOrigin`)    | Vercel    | Required under `postgres`. Under `convex`, `MCP_JWT_ISSUER` is still accepted as a deprecated fallback name for the same value; see "Kept from the Convex era" below |
| `MCP_OAUTH_ENCRYPTION_KEY`            | `lib/mcp/oauth.ts`                                 | Vercel    | Required on both surfaces; unchanged from the Convex era |
| `MCP_TOOL_PROFILE`                    | `lib/mcp/tool-policy.ts`                           | Vercel    | Optional on both surfaces; `full` by default, `memory` narrows the runtime tool set |
| `FINANCE_ARCHIVE_READER_DATABASE_URL` | `lib/mcp/finance.ts`                               | Vercel    | Optional on both surfaces; the financial archive as its reader role, unchanged from the Convex era |
| `FINANCE_ARCHIVE_SPACE_ID`            | `lib/mcp/finance.ts`                               | Vercel    | Optional; required together with the URL above |
| `FINANCE_ARCHIVE_CURSOR_SECRET`       | `lib/mcp/finance.ts`                               | Vercel    | Optional; required together with the URL above -- at least 32 bytes, signs the archive's paging continuations |
| `BRAIN_EMBED_API_KEY`                 | `packages/kith-store/src/embeddings/provider.ts` (`loadEmbeddingConfig`), reached through `lib/mcp/embedder.ts`'s shared seam | Vercel | Optional; takes precedence over `OPENAI_API_KEY` when set |
| `OPENAI_API_KEY`                      | Same, via `lib/mcp/embedder.ts`                    | Vercel    | Optional; the default embedding key when `BRAIN_EMBED_ENDPOINT` is unset or is still the default OpenAI endpoint |
| `BRAIN_EMBED_ENDPOINT`                | Same                                               | Vercel    | Optional; a custom endpoint requires `BRAIN_EMBED_PROVIDER_ID` and `BRAIN_EMBED_MODEL_REVISION` together with it |
| `BRAIN_EMBED_PROVIDER_ID`             | Same                                               | Vercel    | Required together with `BRAIN_EMBED_ENDPOINT`; otherwise optional |
| `BRAIN_EMBED_MODEL`                   | Same                                               | Vercel    | Optional; selects a compatible model |
| `BRAIN_EMBED_MODEL_REVISION`          | Same                                               | Vercel    | Required together with `BRAIN_EMBED_ENDPOINT`; otherwise optional |
| `BRAIN_EMBED_DIMENSIONS`              | Same                                               | Vercel    | Optional; must be `1536` for the current vector index when set |
| `ANTHROPIC_API_KEY`                   | `packages/kith-store/src/memory/captureClassifier.ts` (`loadCaptureClassifierConfig`), reached through `lib/kith/capture.ts`'s classifier seam | Vercel | Optional; see below |
| `KITH_STORE_DATABASE_URL`             | `packages/kith-store/src/deferred/cli.ts` (`kith-deferred-work`) | Daemon | Required for the daemon. A broader-privilege connection string than `KITH_DATABASE_URL`: the daemon and the migration tooling use it, the web app's narrower app role never does |

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

`ANTHROPIC_API_KEY` on this row is the *web* deployment's key, distinct from
the Convex-era row of the same name earlier in this document: under
`convex`, narrative capture's admission gate runs on the Convex deployment
and reads its own `ANTHROPIC_API_KEY` there; under `postgres`, the same gate
(`lib/kith/capture.ts`'s `captureThoughtFromWeb`, shared by the MCP
`capture_thought` tool and the dashboard's Quick Capture button) runs on the
web deployment and reads this one instead. Optional in the sense the
self-hosting doc already uses for the Convex-era key: the gate fails closed
without it, so a `capture_thought` call or a Quick Capture submission returns
`needs_confirmation` ("Memory was not stored because the admission check was
unavailable") and stores nothing, rather than storing unclassified. Provider-
free inline capture and keyword search remain unaffected. Setting the key
only on the Convex deployment while running `KITH_POSTGRES_SURFACE=postgres`
does not enable narrative capture on this surface; it has to be set on
Vercel as well.

### Kept from the Convex era, still required

`NEXT_PUBLIC_CONVEX_URL` (Vercel) stays required under both surfaces. i2 moves
MCP authentication off Convex, but the 17 MCP tools stay on it until i3 and
i4's ported services are reached from `postgres`'s branch of each tool, and a
`postgres` deployment that dropped this variable today would authenticate and
then fail at the first tool call. `MCP_JWT_ISSUER` on the *Convex* deployment
(set with `convex env set MCP_JWT_ISSUER`, read by `auth.config.ts`,
`lib/mcpAuth.ts` and `lib/webAuth.ts`) stays required regardless of which
surface the web deployment reads, because those three files must still agree
on one issuer until i7b deletes the JWT bridge entirely. Only the *web*
deployment's spelling renamed, to `MCP_PUBLIC_ORIGIN`.

### Read only under `convex`

`MCP_JWT_PRIVATE_JWK`, `MCP_JWT_PUBLIC_JWK` and `MCP_JWT_KEY_ID` (Vercel) are
required under `convex` and validated for shape whenever present under
`postgres`, but nothing on the `postgres` branch of any route reads them:
`lib/mcp/convex-auth.ts`, the only place that mints a token from them, is
reached only from each dual-surface route's `convex` branch.
`MCP_JWT_ISSUER` on the *web* deployment is the deprecated spelling of
`MCP_PUBLIC_ORIGIN`; it is still accepted there under `convex` and reported by
`validateMcpEnvironment` as `deprecated` (not `missing` or `invalid`) so a
working deployment is not told it is broken, but nothing reads it at all
under `postgres`, so a `postgres` deployment that never had it set is told
nothing about it either.

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

`KITH_STORE_DATABASE_URL` is the only environment variable it reads today;
there is no default connection string. `docs/kithmind-deferred-work.launchd.plist.txt`
is the per-user LaunchAgent template: a private wrapper script (not the
checked-in plist) exports `KITH_STORE_DATABASE_URL` from a Keychain item, the
same pattern `docs/worker-service.md`'s filesystem-worker wrapper uses for its
own credential, and execs `kith-deferred-work tick --interval-ms 60000` --
matching the per-minute cadence of the two Convex crons this daemon replaces
that ran that often.

The `embedding_fill` deferred-work kind is registered in
`packages/kith-store/src/deferred/registry.ts` but has no handler wired in
yet (see that file's own comment). Once a fill handler lands, it will call
the same embedding provider `lib/mcp/embedder.ts` calls from the web
deployment, which means the daemon's environment will need the same
`BRAIN_EMBED_*`/`OPENAI_API_KEY` rows documented above, set independently on
the daemon host -- the two processes share no environment. This runbook will
gain that requirement in the row that lands the handler; it is not required
today.

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

Copy `apps/web/.env.example` to the ignored `apps/web/.env.local`, set the
development `NEXT_PUBLIC_CONVEX_URL`, and run `pnpm dev`. The web application
works locally with the development Convex deployment. A cloud Convex
deployment cannot fetch a localhost MCP issuer or JWKS endpoint, so complete
MCP/OAuth acceptance requires a reachable HTTPS web deployment.

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
`https://your-project.vercel.app`, with no path or trailing slash. The Convex
and Vercel values must be identical. Do not deploy until the Convex names pass
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

- `NEXT_PUBLIC_CONVEX_URL`
- `MCP_JWT_ISSUER`
- `MCP_JWT_PRIVATE_JWK`
- `MCP_JWT_PUBLIC_JWK`
- `MCP_JWT_KEY_ID` (optional; defaults to `mcp-1`)
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

Generate the signing pair and OAuth encryption key once on a trusted local
machine. Prefer writing them directly to the ignored local environment file so
the secret values do not pass through terminal history or logs:

```sh
pnpm generate:mcp-jwks -- --env-file apps/web/.env.local
```

The command refuses to replace configured values; clear a value explicitly if
you intentionally need to rotate it. Running without `--env-file` prints the
values for manual setup, so do not save or paste that output into the
repository or a conversation. Only `NEXT_PUBLIC_CONVEX_URL` may be exposed
through a `NEXT_PUBLIC_` variable.

Do not rotate the signing or encryption values as routine maintenance for this
personal deployment. Rotating the OAuth encryption key invalidates existing
client registrations and requires each MCP client to reconnect.

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
| OAuth metadata has the wrong host            | Make `MCP_JWT_ISSUER` the final stable HTTPS origin and redeploy Vercel                                                  |
| Convex rejects MCP identity tokens           | Match `MCP_JWT_ISSUER` in both systems, then redeploy Convex                                                             |
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
