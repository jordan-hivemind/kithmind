# Kith Mind

Kith Mind is a personal knowledge base that an AI assistant can read and write.
You tell Claude or ChatGPT something once. It is still there next week, in a new
conversation, in the other assistant.

It stores three kinds of knowledge:

| Kind      | Example                                              |
| --------- | ---------------------------------------------------- |
| Facts     | A provider name, a school, a policy number, a date   |
| Thoughts  | A decision and why you made it, a project's state    |
| Documents | A statement or note you captured, with the text kept |

You host it yourself. The data sits in your own Convex deployment, not in a
shared service. Assistants reach it over MCP, so no browser extension or
copy-paste is involved.

## Use it with Claude or ChatGPT

Steps 1 through 3 happen once. Step 4 is the daily part.

### Step 1. Deploy your own instance

Fork the repository, then follow
[`docs/self-hosting.md`](./docs/self-hosting.md). It walks through one Convex
project, one Vercel project, and the environment variables that connect them.
Node.js 22 or newer and pnpm 10.20 are the only prerequisites.

You finish this step with an HTTPS address such as
`https://your-project.vercel.app`. Your MCP endpoint is that address plus
`/api/mcp`.

Expect a small monthly bill at most. Convex and Vercel free tiers cover light
personal use. Semantic search and narrative analysis call OpenAI and Anthropic
and are metered, but both are optional. Keyword search and capture work without
either key.

### Step 2. Create your account

Open the deployed web app and sign up. This account owns your Personal space.
Everything you capture goes there unless you later create a shared space.

### Step 3. Connect your assistant

In **Claude**, open Settings, then Connectors, then add a custom connector
pointing at `https://your-project.vercel.app/api/mcp`. Sign in through the
OAuth prompt using the account from step 2, then approve the permissions.

In **ChatGPT**, add the same URL as a custom MCP connector. Custom connectors
require a paid plan.

In **Claude Code**, skip the browser:

```sh
claude mcp add --transport http kithmind https://your-project.vercel.app/api/mcp
```

Grant read permission on your Personal space first. Add write and ingest
permissions when you actually need them.

### Step 4. Talk normally

There is no special syntax. Say durable things and the assistant stores them.

> Our new pediatrician is Dr. Reyes at Lakeside Family Health.

> We decided to keep the 2019 Outback instead of trading it in, mostly because
> the quote on the replacement was 9k over what we wanted to spend.

Ask about them later, in any connected assistant, in a fresh conversation:

> Who is the kids' pediatrician?

> Why did we keep the Outback?

The assistant decides when to call the tools. Kith Mind describes very clearly
when each tool should be used, but it cannot see your conversation unless the
client calls a tool. If an assistant is quiet about it, say "remember this" or
"check my knowledge base" and it will.

### Step 5. Confirm it actually stuck

Worth doing once, with a fact you do not mind being wrong:

1. State a fact, then ask for it back using different words.
2. Change the fact. Confirm you get the new value, and that asking what it used
   to be returns the old one as superseded.
3. Correct a fact you got wrong. It is retracted, not recorded as once true.
4. Repeat a fact. It does not duplicate.

### Step 6. Add family, optionally

Use **Spaces** in the web app to create a shared space and invite someone. They
accept an invite link, you approve them, and you both get shared access with
Personal spaces still private. Roles, person links, and scoped API keys are in
the [family spaces guide](docs/family-spaces.md).

## What the assistant gets

| Tool                                                   | Purpose                               |
| ------------------------------------------------------ | ------------------------------------- |
| `remember_fact`, `search_facts`                        | Precise facts, with history           |
| `capture_thought`, `search_thoughts`, `recall_context` | Narrative memory and grounded recall  |
| `search_documents`, `get_document`, `list_sources`     | Captured documents and retained text  |
| `query_records`                                        | Typed lab, vehicle, and money records |
| `create_list`, `get_open_items`, and the list tools    | Simple shared lists                   |

Set `MCP_TOOL_PROFILE=memory` to expose the memory and document tools only.
The default is the full set.

## Where it stands

Working today: typed facts with supersession and retraction, narrative thoughts
with hybrid retrieval and citations, authenticated text capture, document
search with semantic and keyword modes, family spaces with invitations and
roles, capability-scoped API keys, and an OAuth MCP gateway. A bounded
filesystem worker can admit local text files.

Not yet: automated connectors, typed extraction from real documents, cloud
monitoring, and bulk backfill of your own archives. The
[architecture document](./docs/plans/2026-09-06-architecture.md) holds the phase
table, and it is the source of truth for what is planned.

Mobile is deliberately thin. Desktop is the primary workflow, and hosted MCP
covers mobile clients that support it. There is no native app planned.

## Running it locally

```sh
pnpm install
cd packages/convex && npx convex dev --once && cd ../..
pnpm --filter @repo/db exec auth --web-server-url http://localhost:3000
cp apps/web/.env.example apps/web/.env.local   # then set the dev Convex URL
pnpm dev
```

`pnpm demo:brain` runs a synthetic end-to-end check that calls no AI provider.
Its four environment inputs are documented in
[`docs/self-hosting.md`](./docs/self-hosting.md).

Before opening a pull request:

```sh
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

[CONTRIBUTING.md](./CONTRIBUTING.md) covers the contribution workflow and
[AGENTS.md](./AGENTS.md) covers agent guidance.

## License

Kith Mind contributions are intended to be MIT-licensed. The repository derives
from earlier work whose attribution is preserved in [LICENSE](./LICENSE) and
explained in [provenance](docs/upstream-provenance.md).
