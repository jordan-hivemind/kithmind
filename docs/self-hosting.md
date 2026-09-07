# Self-hosting Kith Mind

This runbook describes the currently implemented account-isolated application.
Family spaces, bounded inline capture, source records, and durable processing
primitives are implemented. Real connector polling, full worker recovery, and
bulk ingestion remain Phase 2 work. Desktop is primary; native mobile
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

| Variable                   | Location          | Purpose                                                               |
| -------------------------- | ----------------- | --------------------------------------------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`   | Vercel/Next.js    | Public Convex client origin; intentionally browser-visible            |
| `MCP_JWT_ISSUER`           | Vercel and Convex | Stable HTTPS origin of the Next.js gateway; values must match exactly |
| `MCP_JWT_PRIVATE_JWK`      | Vercel only       | Signs 60-second Convex identity tokens; secret                        |
| `MCP_JWT_PUBLIC_JWK`       | Vercel only       | Published through the MCP JWKS endpoint                               |
| `MCP_JWT_KEY_ID`           | Vercel only       | Optional signing-key identifier; runtime defaults to `mcp-1`          |
| `MCP_OAUTH_ENCRYPTION_KEY` | Vercel only       | Encrypts OAuth registrations and authorization codes; secret          |
| `MCP_TOOL_PROFILE`         | Vercel only       | `full` by default; `memory` is an optional narrower runtime profile   |
| `OPENAI_API_KEY`           | Convex only       | Creates embeddings; secret and billed to the self-host                |
| `ANTHROPIC_API_KEY`        | Convex only       | Extracts and classifies memories; secret and billed to the self-host  |
| `SITE_URL`                 | Convex only       | Stable HTTPS origin of the Next.js app used by Convex Auth            |
| `JWT_PRIVATE_KEY`          | Convex only       | Signs Convex Auth session tokens; generated secret                    |
| `JWKS`                     | Convex only       | Public key set used to verify Convex Auth session tokens              |

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

## 5. Create the two accounts and family space

1. Open the deployed web application and create the primary account.
2. Sign out or use a separate browser profile and create the second account.
3. In each account, create its own Kith Mind API key if direct MCP setup asks for
   one. Never share one account's key with the other account.
4. Connect each person's ChatGPT and Claude clients to
   `https://your-ai-brain.example.com/api/mcp` and complete OAuth while signed
   in as that person.

The same optional server-side OpenAI and Anthropic credentials serve both
accounts. Those provider keys are not exposed to either user or MCP client.

To verify family access with synthetic labels, use **Spaces** in the first
account to create a shared space and invite the second account. Copy the secret
invite link immediately; it expires after seven days. The second account must
accept the link, after which the first account approves the concrete accepted
account. Create one person record per synthetic member and explicitly link
each member. Verify that both accounts can read the shared record, neither can
read the other's Personal record, a Reader cannot write, and an Editor can
write. Transfer ownership to the second account, confirm the first becomes an
Editor, then verify that removing a member ends access. The last owner cannot
be removed or leave.

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
