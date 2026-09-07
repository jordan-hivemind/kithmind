# Kith Mind

Kith Mind is a personal knowledge system built on the upstream
[ai-brain](https://github.com/flippyhead/ai-brain) foundation. Its source is
available and is intended to be MIT-licensed, pending confirmation of the
upstream license scope (see [provenance](docs/upstream-provenance.md)). It currently stores structured facts and narrative
thoughts, and makes them available to compatible clients through MCP. The
public architecture and staged plan are in
[`docs/plans/2026-09-06-architecture.md`](./docs/plans/2026-09-06-architecture.md).

## Available today

- Typed entities and facts, including current, superseded, and retracted
  records.
- Narrative thoughts with hybrid retrieval, grounded recall, and citations.
- Per-account isolation, API keys, and an OAuth-capable MCP gateway that
  exchanges credentials for short-lived Convex identities.
- A Next.js web application, Convex backend, and a Claude Code plugin source.

Captures are client-mediated: an MCP server cannot observe a conversation
unless a connected client calls a capture tool. See
[`docs/self-hosting.md`](./docs/self-hosting.md) for the current deployment
requirements, including server-side OpenAI and Anthropic API credentials.

## Planned work

The following are architecture commitments, not current product features:

- Shared family spaces and per-space authorization.
- Source-backed documents, chunks, ingestion jobs, and document-query MCP
  tools.
- A Mac-hosted daemon, filesystem and service connectors, extraction
  playbooks, and background ingestion.
- Desktop is the primary workflow. P2 mobile access is through hosted MCP for
  supported native clients; where a client lacks remote MCP support, a thin
  authenticated API adapter is an option to validate. An iOS Shortcut is an
  optional capture surface only, not a query client. A native mobile app is
  not planned.

The phase table in the architecture document is the source of truth for scope
and ordering.

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
