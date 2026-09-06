# Kith Mind: architecture and plan of attack

**Date:** 2026-09-06
**Status:** Adopted 2026-09-06
**Scope:** A personal (and optionally family) knowledge system that any LLM client can consult over MCP, fed continuously by connectors to email, files, web portals, spreadsheets, messaging, and photos, with every fact traceable to its source. Built to be open-sourced with a replication recipe.

## 1. Decision summary

| Question | Decision | Why |
|---|---|---|
| Base | Extend `ai-brain` (Convex + Next.js + MCP) | It already has the hard, novel part: typed facts with supersede/retract history, narrative thoughts, Smart Save, multi-account isolation, OAuth for Claude and ChatGPT. Nothing surveyed has fact-level provenance to an email thread or a file page, and the ingestion projects are enterprise stacks or AGPL. |
| Layering | Three separable layers: **Brain** (store + MCP), **Pipeline** (connectors + extraction), **Automation** (watch registry, routes, agents, capture surfaces) | Each is independently replaceable and independently useful. A stranger could adopt the Brain with their own connectors, or the connectors with their own store. |
| Where ingestion runs | A daemon on a Mac (a Mac mini or similar always-on machine), stateless except for local file access. All cursors and job state live in the Brain. | Some sources are only readable on macOS. Keeping state in the cloud makes the daemon movable and catch-up automatic. |
| Agent runtime | Claude Agent SDK inside the daemon for agentic jobs; plain code for everything deterministic. OpenClaw and headless Claude Code are optional adapters, not the core. | See section 6. |
| Models | Hybrid, one provider setting per task. Default recipe: local OCR and embeddings on the Mac, cloud (Claude) for classification-sensitive extraction and agents. | See section 7 for hardware capabilities. |
| Sensitive data | Cloud is acceptable for this deployment. The repo ships a SECURITY.md and a threat model; local-only mode is a documented configuration, not a fork. | Project decision. |
| Sharing | Add `spaces` (personal and shared). Every record belongs to a space; users are members of spaces; connectors write to a configured space. | Enables a family brain where shared sources feed a shared space with consent, while each person keeps a private space. |

## 2. Requirements, restated as acceptance tests

Each phase ends when a fresh Claude or ChatGPT session, with only the Brain MCP attached, answers correctly and returns a working link to the source.

1. "How much did I pay my primary financial institution in fees in 2023?" Answer with a per-statement breakdown and links to each statement PDF and page.
2. "What did I pay in capital gains tax in 2022?" Answer with the return line, linked to the return PDF.
3. "Did the SAFE for company X include a most-favored-nation clause?" Answer from the document text, quoting it, with a page link.
4. "When was the car last serviced, where, what did it cost, and what did they do?" Answer from an email receipt, linked to the email thread.
5. "Has a family member ever been tested for a genetic condition?" Answer across portal archives, scanned documents, email, and specialist messages, with links.
6. "What is on the investments sheet for company Z?" Answer from the watchlisted Google Sheet, with a cell link, current as of the last poll.
7. A new document dropped into cloud storage on a day the daemon was off is ingested when the daemon returns, exactly once.
8. Two accounts in the same deployment never see each other's private space; both see the shared family space.

## 3. Layer A: the Brain (store and MCP)

Existing: `entities`, `facts`, `thoughts`, `lists`, `reports`, `apiKeys`, OAuth. Additions:

### 3.1 Spaces

- `spaces` (name, kind: personal | shared, createdBy) and `spaceMembers` (spaceId, userId, role: owner | editor | reader).
- Every content table gains `spaceId`. `userId` remains as author. Indexes move from `by_userId` to `by_spaceId`.
- `recall_context` and every search take the union of the caller's spaces by default, with an optional `spaces` filter, and label each hit with its space.
- Entity resolution is per space. A name in the family space is one entity; a personal space can reference it by key.

### 3.2 Provenance

Replace the free-text `sourceRef` with a structured `source` on facts, thoughts, documents, and chunks:

```
source: {
  kind: "conversation" | "email" | "file" | "web" | "sheet" | "message" | "portal" | "photo",
  connector: "gmail" | "fs" | "gsheets" | "web-capture" | "imessage" | "slack" | "discord" | "mychart" | "photos" | "mcp-client",
  accountId: string,              // which mailbox / which cloud root / which person's device
  uri: string,                    // stable machine id, see below
  href: string,                   // best human link (Gmail permalink, cloud web link, sheet cell URL)
  locator?: { page?: number; range?: string; quote?: string; offset?: number },
  capturedAt: number,
  contentHash?: string,
}
```

URI conventions, so a moved machine or a re-synced cloud folder does not break links:

- `file://<rootName>/<relative path>` where rootName is a configured alias such as `dropbox`, never an absolute path.
- `gmail://<account>/thread/<threadId>/msg/<messageId>`
- `gsheet://<spreadsheetId>/<sheetName>!<A1 range>`
- `imessage://<chatGuid>/<rowid>`
- `https://...` for web captures, with the archived copy recorded as a second `file://` source.

New `sourceType` values on facts: `ingested` (machine-extracted, carries confidence) alongside the existing `user_stated` and `user_confirmed`. Recall ranks user-stated above ingested when they conflict, and Smart Save's precedence rules treat an ingested fact as a candidate that a user statement supersedes.

### 3.3 Documents and chunks

- `documents`: spaceId, source, docType, title, summary (one paragraph), fields (JSON, per-playbook structured extraction), textHash, pageCount, status (queued | extracted | failed), ingestedAt, supersededBy (for a re-scanned or re-downloaded copy).
- `chunks`: documentId, spaceId, ordinal, text, locator, embedding. Vector index filtered by spaceId and documentId.
- `documents.fields` is what answers aggregate questions. A brokerage statement yields `{period, fees: [{label, amount}], realizedGains, ...}`; a SAFE yields `{company, amount, valuationCap, discount, mfn, proRata, date}`; a visit note yields `{provider, date, diagnoses, tests, followUps}`. The playbooks that define these live in the Pipeline layer, but the Brain stores the result.

### 3.4 Ingest queue and cursors

- `ingestJobs`: spaceId, connector, accountId, uri, contentHash, priority, status, attempts, error. Idempotent on (uri, contentHash).
- `watcherState`: one row per watcher instance holding its cursor (Gmail historyId, Drive changes page token, filesystem walk timestamp, portal rowid). This is what makes the daemon movable: a new machine reads the cursor and continues.

### 3.5 New MCP tools

`search_documents(query, docType?, dateRange?, spaces?)`, `get_document(id, page?)` returning text plus links, `query_fields(docType, filter)` for aggregation questions, `ingest_url(url, note?)` for the browser button, `list_sources()` so a client can say what it knows about. Existing tools gain `spaces` and return `source.href` on every hit.

### 3.6 HTTP ingest endpoint

`POST /api/ingest` (API key or OAuth) accepting `{spaceId, source, text | fileUrl, hint?}`. It enqueues an `ingestJob` and, for text-only payloads, runs the pipeline in a Convex action. This single endpoint serves the Chrome extension, an OpenClaw skill, a Shortcuts action on the phone, or anything else.

## 4. Layer B: the Pipeline (connectors and extraction)

A pure TypeScript package, `packages/pipeline`, with no knowledge of scheduling. Stages are functions so they can run in the daemon (local files) or in a Convex action (web captures).

```
Connector.list(cursor)  -> events[] + nextCursor     // what changed since cursor
Connector.fetch(event)  -> Item { source, bytes | text, mime, metadata }
extractText(item)       -> pages[]                    // pdftotext, OCR, docx, xlsx, html, transcript
classify(pages, hint)   -> docType                    // small model, cheap
playbook[docType]       -> { summary, fields, factCandidates[] }   // capable model, schema-constrained
chunk(pages)            -> chunks[]  ;  embed(chunks)
write(brain, document, chunks, factCandidates)        // facts go through Smart Save with sourceType ingested
```

### 4.1 Connectors (initial set, all behind one interface)

| Connector | Cursor | Notes |
|---|---|---|
| `fs` | last walk time + per-file hash | Allowlist of roots and globs. Cloud sync folders are just local folders. Excludes miscellaneous, code, caches. FS events (fswatch) only trigger an early poll; the walk is the source of truth, which is what gives catch-up. |
| `gmail` | historyId | One OAuth grant per mailbox. Multiple mailboxes are multiple `accountId`s writing to configured spaces. Thread permalink stored as `href`. Attachments become documents with the email as parent. |
| `gsheets` | Drive changes page token | Watchlist of spreadsheet ids. Emits row-level diffs so facts update instead of duplicating. |
| `web-capture` | none (push) | Chrome extension or phone Shortcut posts to the ingest endpoint. Readability-extracted text plus a PDF snapshot archived to the archive folder. |
| `imessage` | chat.db rowid | Reads `~/Library/Messages/chat.db` (needs Full Disk Access). Existing tools: imessage-exporter, or BlueBubbles for a server. Later. |
| `slack`, `discord` | per-channel ts / message id | User token or bot token. Later. |
| `photos` | Photos library version | Reads people, places, dates that Apple Photos already computed, via `osxphotos`. Cold storage folders not in Photos get a separate CLIP/face pass. Phase 6. |
| `audio` | fs | Voice memos and recordings transcribed locally with whisper.cpp, then treated as documents. |

### 4.2 Playbooks

A playbook is a document type definition: a detection hint, a JSON schema for `fields`, an extraction prompt, and a list of which fields become facts on which entity. They live in `playbooks/*.yaml` and are the main thing a new user customizes. Initial set: brokerage statement, tax return (1040 and state), K-1, SAFE, convertible note, subscription agreement, side letter, invoice or receipt, vehicle service record, insurance policy, lease, medical visit note, lab or imaging result, specialist message, referral, school record, generic letter.

### 4.3 Health archive

"Locked" portal data becomes plain files before it is ingested, so it survives losing portal access:

- A `Health/<person>/<source>/<yyyy>/` folder in cloud storage is the archive. Once written there it is an ordinary `fs` document.
- Sources: portal record export (CCDA or FHIR bundle, and the Apple Health clinical records export on iPhone, which pulls FHIR from Epic organizations), a browser-driven agent that saves results, notes, and messages as PDFs while a person is signed in, scans of the binder (phone scan or a sheet-fed scanner into the folder), family members' cloud folders (a second `fs` root with their consent), and family members' mailboxes (additional `gmail` accounts into the family space).
- A `health-timeline` consolidation agent maintains one narrative thought per person per condition from the documents, with citations, so "have we ever tested for X" is answered from a curated summary first and raw documents second.

## 5. Layer C: Automation (watch registry, routes, agents, capture surfaces)

### 5.1 The watch registry

Watchers are data, not code. `brain.config.yaml` (checked into the user's private config, with an example in the repo):

```yaml
spaces:
  personal: alice
  family: example-family
watchers:
  - id: cloud-financial
    connector: fs
    account: cloud-storage        # root alias -> configured path
    paths: ["Financial/**"]
    space: personal
    schedule: "every 15m"          # plus fs events
  - id: cloud-health
    connector: fs
    paths: ["Health/**"]
    space: family
  - id: gmail-alice
    connector: gmail
    account: alice@example.com
    space: personal
    schedule: "every 10m"
    routes:
      - match: { from: "*@portal.*", subject: "/new (result|message)/i" }
        handler: agent:portal-digest
      - match: { from: "*@financialinstitution.com", hasAttachment: true }
        handler: ingest_attachments
      - match: { label: "receipts" }
        handler: ingest_email
      - default: classify_then_route     # small model decides ingest / ignore
  - id: investments-sheet
    connector: gsheets
    ids: ["<spreadsheet id>"]
    space: personal
    schedule: "every 1h"
```

The daemon loads this, registers cursors in `watcherState`, and runs each watcher on its schedule. Adding a watcher is adding an entry. Adding a connector type is adding one module that implements `list` and `fetch`.

### 5.2 Routes and handlers

A route matches event attributes to a handler. Handlers are: `ingest_email`, `ingest_attachments`, `ingest_document`, `ignore`, `classify_then_route`, and `agent:<name>`. The last one is the escape hatch for anything that needs judgment or a browser: the portal digest, a "new K-1 arrived, file it and update the tax checklist" job, or a weekly consolidation.

### 5.3 Agents

`agents/<name>.md`: a prompt, allowed tools (Brain MCP, browser, filesystem within the archive folder), a budget, and an output contract (documents and facts it may write, always with provenance). Run by the daemon with the Claude Agent SDK. Initial agents:

- `portal-digest`: on a portal notification, open the portal in a signed-in browser profile, save the new item to the health archive, enqueue it.
- `weekly-consolidate`: rebuild per-topic summaries (each investment, each health condition, each property, the car) and mark them core if the owner has flagged the topic.
- `intake-triage`: during the initial backfill, sample low-confidence classifications and ask the owner in a batch, so "training about what matters" is a review queue rather than a chore.

### 5.4 Capture surfaces (how conversations and browsing feed the Brain)

- MCP server instructions already ask capable clients to call `remember_fact` and `capture_thought`. Unchanged.
- Claude Code plugin: SessionStart recall hook exists; add a Stop hook that offers durable items from the session to Smart Save.
- Chrome extension: a "remember this" button posting the page (URL, selection, readable text, PDF snapshot) to the ingest endpoint with a space picker. Works on portals and any other web application because it runs in the user's signed-in tab.
- Phone: an iOS Shortcut that shares a photo, PDF, or URL to the ingest endpoint. Scanning the binder is this Shortcut plus the Notes scanner.

### 5.5 Resilience and catch-up

- Every connector is cursor-based polling; events only accelerate a poll. Off for a week means one bigger poll.
- Jobs are idempotent on (uri, contentHash). Re-running the backfill is safe.
- Daemon state is in the Brain, credentials are in the macOS Keychain, config is a file. Moving machines is: install, sign in, `brain daemon --catch-up`.
- Backpressure: the daemon caps model spend per day and per connector; anything over the cap stays queued with a visible count in the web UI.

## 6. Agent runtime options (Automation layer)

| Option | What it gives | Cost | Verdict |
|---|---|---|---|
| Claude Agent SDK inside our daemon | Full control, one codebase, the Brain MCP as the only memory, deterministic scheduling in code | We write scheduling, retries, and the browser tool wiring | **Core.** |
| OpenClaw as orchestrator | Channels (iMessage, WhatsApp, Slack, Discord, Telegram), cron and heartbeat, browser control, skills, large community | A very large attack surface on a machine holding medical and financial data; its own Markdown memory competes with the Brain; opinionated runtime we would be wrapping | **Optional adapter.** Ship an OpenClaw skill that calls the ingest endpoint and the Brain MCP, so an OpenClaw user gets the channels for free. Do not build the pipeline on it. |
| Headless Claude Code on launchd | Zero code to try an agent job today | Not a product, no queue, no cursors | **Prototype tool** for agent work before it is productized. |
| Cloud scheduled routines | No local machine | Cannot read local files or private device data | Used only for cloud-side jobs such as weekly consolidation, if the daemon is ever retired. |

## 7. Local models on the Mac (M4 example: 10-core GPU, 24 GB unified, 512 GB SSD)

What 24 GB carries comfortably, with Ollama or MLX:

| Task | Local option | Fit | Recommendation |
|---|---|---|---|
| Embeddings | Qwen3-Embedding-4B (Apache-2.0, Matryoshka output at 1024-dim) as the default; bge-m3 (MIT, 1024-dim) as the alternative | Trivial, hundreds of chunks per second | **Local.** Free, private. Model and dimension are configuration; the index is fixed at 1024. Run the existing `eval:recall` baseline on both models during the Phase 2 backfill and keep the winner. Re-embedding is a local batch job, so revisiting later costs time, not money. |
| OCR | Apple Vision (macOS framework, via a small Swift or `ocrmac` shim) or Tesseract | Fast, excellent on scans | **Local.** Apple Vision is the best free OCR on this hardware. |
| Audio transcription | whisper.cpp large-v3-turbo | Real time or faster on M4 | **Local.** |
| Classification and chunk summaries | Qwen3-14B or Gemma 3 12B at Q4 (about 9 GB), 20 to 30 tokens per second | Fine for high-volume, low-stakes calls | **Local by default**, cloud fallback on low confidence. |
| Structured extraction from statements, tax returns, medical notes | Qwen3-30B-A3B Q4 (about 18 GB, tight) or cloud | Local 14B models miss line items and mis-key schemas often enough to matter for money and health | **Cloud (Claude Haiku 4.5 for bulk, Sonnet 5 for hard docs).** The full backfill is roughly 10k pages, under $50 once; ongoing volume is small. |
| Agents with a browser | Cloud | Local models are not reliable enough for multi-step portal navigation | **Cloud.** |

Every task has one setting (`BRAIN_MODEL_EMBED`, `BRAIN_MODEL_CLASSIFY`, `BRAIN_MODEL_EXTRACT`, `BRAIN_MODEL_AGENT`), so a user with no Mac sets all four to cloud and a user with a 64 GB machine sets all four local. The 512 GB SSD may not be enough to hold a large media corpus plus models plus a full cloud mirror; selective sync on the Mac should include important document folders, and media ingestion should read from external storage when available.

## 8. Security and privacy (what SECURITY.md will say)

- What leaves the machine: extracted text and embeddings go to Convex (encrypted at rest, TLS); extraction calls go to the configured model provider. Raw files never leave cloud storage. Local-only mode keeps text and embeddings on the Mac with a local MCP, at the cost of cloud clients.
- Provider data handling: use API keys with zero-retention terms; never consumer chat accounts for ingestion.
- Access: OAuth for clients, hashed API keys, per-space membership checked in every query and mutation (already the pattern), short-lived signed identities for MCP.
- Secrets: Keychain on the daemon host, deployment environment on Convex and Vercel, nothing in config files.
- Threat model: a compromised MCP client can read the spaces its user belongs to and nothing else; a compromised daemon host exposes local files (which it already could); the ingest endpoint accepts only authenticated pushes and never follows instructions inside ingested content.
- Prompt injection: ingested text is data. Extraction prompts are schema-constrained; agents get an allowlist of tools and domains; anything an agent wants to write that is not a document or a candidate fact is dropped.
- Personal use is not covered-entity use. Say so plainly; do not claim HIPAA compliance.

## 9. Repository shape

```
apps/web              existing Next.js UI + MCP gateway (+ ingest endpoint, sources UI, review queue)
apps/daemon           Mac runner: config loader, scheduler, connectors, agents, catch-up
apps/extension        Chrome "remember this" (phase 5)
packages/convex       existing store (+ spaces, documents, chunks, ingestJobs, watcherState)
packages/pipeline     pure stages: extractText, classify, playbooks, chunk, embed, write
packages/connectors   fs, gmail, gsheets, web-capture, imessage, slack, discord, photos, audio
playbooks/*.yaml      document types
agents/*.md           prompted jobs
plugins/ai-brain      existing Claude Code plugin (+ Stop hook)
docs/recipe.md        end-to-end replication runbook
SECURITY.md
```

## 10. Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | This document approved; naming and upstream decision | Sign-off |
| 1 | Brain: spaces, provenance, documents, chunks, ingest queue, watcher state, new MCP tools, ingest endpoint, embedding model switch | Test 8; existing tests green |
| 2 | Pipeline + `fs` connector + daemon skeleton on the Mac; playbooks for financial doc types; backfill financial documents and statement batch | Tests 1, 2, 3, 7 |
| 3 | `gmail` connector, routes, `classify_then_route` | Test 4 |
| 4 | Health archive folder, `gsheets`, `portal-digest` agent, binder scan flow, family members' cloud folders and mailboxes as second accounts into the family space, `health-timeline` consolidation | Tests 5, 6 |
| 5 | Capture surfaces: Chrome extension, Claude Code Stop hook, iOS Shortcut, `imessage` | Owner uses them for a week |
| 6 | Photos: `osxphotos` metadata import, cold-storage face and CLIP pass on external storage | Photo queries across the corpus |
| 7 | Open-source hardening: recipe, SECURITY.md, example config, demo dataset, one-command install for daemon and web | A second person replicates from the README |

## 11. Decisions

Made by the project on 2026-09-06:

1. **Diverge under a new name.** This repository leaves the upstream ai-brain project lineage. Changes are offered upstream as PRs if the upstream maintainers want them; nothing here waits on that. Upstream credit: the ai-brain project by Peter Brown, MIT.
2. **Local models wherever results are good.** Embeddings, OCR, transcription, and bulk classification run on the Mac. Extraction that affects money or health, and browser agents, use Claude. The embedding default is Qwen3-Embedding-4B at 1024 dimensions, with bge-m3 evaluated against it on the real corpus in Phase 2 (section 7). This is a moving target; the provider settings exist so the choice can change.
3. **Chrome extension first** among capture surfaces. An iOS Shortcut ships only if it is a one-tap share-sheet action; anything with more friction is dropped.
4. **Implementation cost and orchestrator hand-off.** Development is delegated by capability tier per `AGENTS.md`. Work state lives in `docs/plans/TRACKER.md` in a private tracker so the next developer can take over with no hand-off.

Still open, non-blocking:

- The permanent project name.
- Whether the daemon's browser agent uses a dedicated Chrome profile on the Mac or the extension on the laptop for portal access. Decide in Phase 4.

## 12. Deliberately deferred

Graph database (Graphiti) until temporal-graph questions appear; reranker; Paperless-ngx (our OCR path covers scans); Immich until Phase 6; Slack and Discord until a use shows up; a mobile app (the Shortcut and MCP clients cover it).
