# Kith Mind

Kith Mind is a personal knowledge system built on the upstream
[ai-brain](https://github.com/flippyhead/ai-brain) foundation. Kith Mind
contributions are intended to be MIT-licensed, with upstream attribution
preserved in the local LICENSE. See [provenance](docs/upstream-provenance.md).
It stores structured facts, narrative thoughts, and indexed source documents,
and makes them available to compatible clients through MCP. Bounded text capture is supported; automated connectors and typed extraction
are still being implemented. The public architecture and staged plan are in
[`docs/plans/2026-09-06-architecture.md`](./docs/plans/2026-09-06-architecture.md).

## Available today

- Typed entities and facts, including current, superseded, and retracted
  records.
- Narrative thoughts with hybrid retrieval, grounded recall, and citations.
- Space-scoped authorization, capability-scoped API keys, and an OAuth-capable
  MCP gateway that exchanges credentials for short-lived Convex identities.
- Source revisions, immutable evidence, processing leases, and atomic publication
  primitives. Indexed read tools are `search_documents`, `get_document`, and
  `list_sources`. See the [processing contract](docs/plans/2026-09-06-source-processing-contract.md).
- Versioned embedding profiles and generations, compatible semantic document
  search, and explicit keyword fallback. See the
  [embedding contract](docs/plans/2026-09-06-embedding-contract.md).
- Versioned lab, vehicle-service and financial records with exact decimal
  queries, retained evidence and coverage-aware pagination through `query_records`.
  See the [typed-record contract](docs/plans/2026-09-06-record-query-contract.md).
- Desktop family spaces with Personal/shared separation, invitation approval,
  roles, explicit person links, default write destinations, source identities,
  and scoped API keys. See the [family spaces guide](docs/family-spaces.md).
- Authenticated text capture with durable processing and retry-safe request IDs,
  plus an explicitly unfetched URL queue. See the
  [capture contract](docs/plans/2026-09-06-inline-ingestion-contract.md).
- A source-scoped remote worker gateway for filesystem discovery, scan retries,
  identity recovery, tombstones, and verified text admission with resumable
  reservations. Document processing through this gateway remains in progress. See the [worker protocol](docs/plans/2026-09-07-worker-protocol.md).
- A Next.js web application, Convex backend, and a Claude Code plugin source.

For local development, run `npx convex dev --once` from `packages/convex`,
configure Convex Auth with
`pnpm --filter @repo/db exec auth --web-server-url http://localhost:3000`,
then copy `apps/web/.env.example` to the ignored `apps/web/.env.local`, set the
development Convex URL, and run `pnpm dev`. The provider-free synthetic smoke
test is `pnpm demo:brain`; see [self-hosting](docs/self-hosting.md) for its
four environment inputs, authentication setup, and the family-space acceptance
flow.

Prerequisites: Node.js 22 or newer and pnpm 10.20. Public-clone setup does not
require private files or owner credentials.

Captures are client-mediated: an MCP server cannot observe a conversation
unless a connected client calls a capture tool. See
[`docs/self-hosting.md`](./docs/self-hosting.md) for the current deployment
requirements and optional server-side OpenAI and Anthropic API credentials.

## Planned work

The following are architecture commitments, not current product features:

- Extraction of typed records from real sources.
- A Mac-hosted daemon, filesystem and service connectors, extraction
  playbooks, and background ingestion.
- Desktop is the primary workflow. P2 mobile access is through hosted MCP for
  supported native clients; where a client lacks remote MCP support, a thin
  authenticated API adapter is an option to validate. An iOS Shortcut is an
  optional capture surface only, not a query client. A native mobile app is
  not planned.

The phase table in the architecture document is the source of truth for scope
and ordering. The [Phase 2 document-pipeline plan](docs/plans/2026-09-07-phase2-document-pipeline.md)
breaks the worker, parser, financial playbooks, monitoring, and restore work into
verified steps before owner-document ingestion and bulk backfill.

## Claude Code plugin

[`plugins/ai-brain/`](./plugins/ai-brain/) contains the upstream AI Brain
plugin source and its skills. Its checked-in
[`.mcp.json`](./plugins/ai-brain/.mcp.json) points to the upstream hosted AI
Brain service. It is not a Kith Mind marketplace install, and it does not add
planned document or family-space capabilities.

For local development against a Kith Mind deployment, make a copy of the
plugin source and change the copy's `.mcp.json` URL to that deployment's
`/api/mcp` endpoint. The copied plugin directory has no standalone marketplace
manifest, so this repository does not yet provide a verified Kith Mind plugin
installation command. The deployment must already have its MCP authentication
configured as described in the self-hosting runbook. A renamed Kith Mind plugin
and public marketplace distribution are future work.

## Development

Install dependencies with `pnpm install`, then run:

```
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the public contribution workflow
and [AGENTS.md](./AGENTS.md) for agent guidance.
