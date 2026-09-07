# Kith Mind architecture review

Date: 2026-09-06. Task: R1-1. Status: recommendations, not adopted decisions.

The architecture is a reasonable starting point, but the current plans are not ready to implement unchanged. Keep the cloud Brain, separate ingestion workers, structured records, source evidence, and family spaces. Revise mobile access, event identity, family entity ownership, recovery, and the release process before a large backfill.

This review covers the public architecture, the owner's private architecture and Phase 1 plan, the tracker, and relevant existing source. Private examples are deliberately omitted. It includes an independent Sol review of the family schema and authorization plan. It is a design review, not a production security audit or an executed mobile compatibility test. The existing uncommitted architecture edit was left intact.

## 1. Mobile access is an early acceptance gate

The architecture's section 2 says Claude or ChatGPT, and section 13 assumes MCP clients cover mobile. That does not establish the requirement that both native mobile apps can query the Brain.

| Surface | Evidence checked on the review date | Consequence |
|---|---|---|
| Claude iOS and Android | Anthropic documents connected services carrying over from web/desktop and supports custom remote MCP connectors. | A hosted Brain is a supported approach. Verify this deployment with real accounts. |
| ChatGPT custom MCP apps | OpenAI's custom MCP FAQ explicitly describes mobile availability as web only. | Do not promise that adding the MCP on desktop makes it usable in native mobile ChatGPT. |
| ChatGPT GPT Actions | OpenAI documents mobile GPT use and external API actions, but its fetched GPT creation page restricts new creation on personal accounts. | A thin authenticated API adapter is a candidate to test with an eligible account or existing GPT. It is not a proven universal workaround. |
| Original files | Brain membership does not confer Gmail, portal, or storage permissions. | Answer from stored evidence. Separately report whether the original can be opened by this caller. |

Sources: [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities), [ChatGPT custom MCP availability](https://help.openai.com/en/articles/12584461), [GPT creation and actions](https://help.openai.com/en/articles/8554397). Search snippets for the GPT page disagreed; the fetched page is the basis here. Recheck account eligibility and installed app versions during the prototype.

Run a small access prototype first: one synthetic lab result, one service record, and one workout, served by a hosted authenticated endpoint. Query them from both native mobile apps with the ingestion computer off. Include OAuth renewal and separate family logins. If ChatGPT needs an adapter, both adapters must call the same authorized Brain queries. A mobile website is a useful fallback, but it does not satisfy the native ChatGPT requirement without an explicit change to that requirement.

MCP exposes tools. It does not automatically inject the whole database into every conversation or observe every chat. The existing README correctly acknowledges client-mediated capture. Test fresh-session tool selection and explicit saving. Do not promise universal automatic memory from ChatGPT and Claude conversations.

## 2. Model life events separately from current facts

The design emphasizes documents and facts that supersede earlier facts. Blood draws, measurements, transactions, and workout sets are repeated events. They need event identity, person or asset identity, event time, units, and evidence. They must survive receiving the same value twice or importing an older record later.

Existing `models/facts/model.ts` defaults to single cardinality, deduplicates current equal values without considering `observedAt`, and writes confidence as 1. Those choices fit some conversational facts, but cannot be reused unchanged for extracted observations. See lines 409-446. Merely adding the `ingested` enum does not implement confidence or conflict policy.

Recommended records can remain in Convex; this does not require a graph database:

| Record | Example and rule |
|---|---|
| Entity | Person, vehicle, account, exercise. Stable identity within a space. |
| Event | Blood draw, oil change, workout session. Date of occurrence differs from import time. |
| Observation or line item | Lab analyte/value/unit, odometer reading, exercise/set/reps/load/unit, transaction amount/currency. Link to its event and field-level evidence. |
| Current fact | Current address or preferred contact method. Can supersede a prior state. |
| Evidence | Source item, immutable revision, page/cell/text span, extraction version. Several sources may support one event. |
| Summary | Rebuildable synthesis referencing underlying records. Never the only surviving evidence. |

The workout requirement is currently missing from the playbooks and acceptance tests. Choose an actual capture route, such as a workout export, a structured quick-entry form, or explicit conversational save. Distinguish body weight from exercise load and ask when the query is ambiguous.

Do not automatically make a remembered user statement override a dated source record. Preserve both claims, their dates, and provenance; let an explicit correction resolve the disagreement. A machine's confidence score alone is not validation.

## 3. Shared family identity and permissions must work end to end

Public architecture section 3.1 places entities in spaces. The Phase 1 scope narrowing leaves entities user-scoped while sharing their facts. Current `resolveEntity` and entity lookups are keyed by user. Two parents can therefore produce different identities for the same child, and changing fact queries alone cannot provide consistent shared retrieval and updates.

Bring entities into the space migration. Keep one family entity for each person and explicit links where a private space needs a separate representation. Prohibit references that disclose inaccessible private entity details. Resolve “me” from the authenticated caller, not the original deployment owner.

The planned helper checks membership, but the schema has owner/editor/reader roles. Enforce operation-specific roles, target-row space checks, and current membership for reads, writes, direct-ID retrieval, history, entity hydration, summaries, and worker finalization. Test revocation while extraction is running. Add invitation, removal, ownership recovery, and default-write-space behavior. Existing remember/capture APIs have no destination space, so propagate it through the public tools and every internal call. Inventory all reads, including direct-ID, recent, core, and timeline paths; the planned two-tool T8 test cannot establish isolation across the complete API.

The example routes put financial records in a personal space. This should be a configuration choice, not an assumption about this family's desired sharing. A shared-first setup with optional private spaces fits the stated goal. Every family member still signs in separately; never share the owner's bearer token. Credential scopes should limit each worker and client to the spaces and operations it needs.

## 4. Exact answers need exact queries and coverage

`documents.fields` plus `query_fields(docType, filter)` does not specify aggregation semantics. Phase 1 stores fields as `v.any()`. There is no contract for person/account filters, date meaning, sort order, pagination, decimal money, units, duplicate statements, or corrected versions.

Define validated, versioned record schemas and deterministic query operations. “Last oil change” should filter the correct vehicle and service type and order by event date. “Fees in a year” should aggregate all eligible line items, not the top semantic-search matches. Return contributing record IDs, coverage, and any excluded or ambiguous items.

Store per-source last successful scan, covered date range, pending/failed count, and known gaps. A result should distinguish:

- No matching record in the indexed material.
- Complete coverage of the requested range with no matching event.
- Partial or stale coverage that cannot support a negative conclusion.

“Never tested” is not established by failing to retrieve a test. A recently imported old statement does not establish recent account coverage. Validate the tax-question fixture's answerability before assuming it maps to one return line.

Interpret “no need to search source material” as no live source fetch, OCR, or re-ingestion for ordinary questions. Looking up stored structured records and indexed text is still necessary. Arbitrary future questions may require stored text beyond fields anticipated by the initial playbooks.

## 5. Source revisions and recovery need explicit contracts

Architecture sections 3.4 and 5.5 overstate exactly-once processing and catch-up. The Phase 1 job key is `(uri, contentHash)`, without the space or source account, and the hash is optional. Two accounts can collide; two changed text posts without hashes can look identical.

Compute hashes at the trusted ingestion boundary. Namespace source identities by space, connector, and account. Use a separate revision and processing-version identity. Specify whether the same source is intentionally imported into multiple spaces. Atomically admit jobs and persist cursor progress with durable enqueueing. Use retries with idempotent committed effects, job ownership/expiry, and recovery after a worker dies between stages. Even one daemon can overlap polls or restart mid-job.

A cursor is not permanent coverage. Gmail explicitly requires a full sync when an old history ID returns 404. Add connector-specific resync and reconciliation paths. A windowed API is not proof the underlying service has permanently deleted the data. The Granola retention and cache assumptions need an actual connector capability test before becoming promises. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync).

A path alias survives moving a synced root but not renaming a file inside it. Preserve a source ID, mutable location, and immutable revisions. Dropbox offers IDs that survive moves and renames; a generic filesystem connector needs its own reconciliation policy. [Dropbox file identity](https://www.dropbox.com/developers/reference/migration-guide).

Store extracted pages independently from chunk layout. Citations should target source revision plus page/span, not a transient chunk ID. Then re-chunking need not re-run OCR or invalidate citations. The claim that chunks cannot cross pages is a restriction of the proposed one-page locator, not a universal requirement; a multi-span locator is another valid choice.

Specify what happens on a source edit, source deletion, deliberate “forget,” duplicate attachment, extraction correction, and summary rebuild. Old extracted facts must not silently remain current after their source revision is replaced. Normal source disappearance and a user's request to erase archived material are different operations.

## 6. Self-management includes operational and security work

A local `brain doctor` cannot alert anyone when its machine is off. Add a cloud-visible worker heartbeat, stale-source detection, failure notifications, retry limits, a review queue, and budget accounting. Automatic routine ingestion is achievable; unknown portal changes, expired consent, and uncertain extraction require a visible exception path.

Before real family records, define backups and prove a restore into an isolated deployment. Include structured data, provenance, original archives or recoverable references, configuration, schema versions, and credential recovery instructions. Cloud synchronization alone does not prove recovery from deletion or corruption.

Architecture section 8 needs corrections:

- API keys do not automatically provide zero retention. OpenAI documents approval requirements. Record actual provider settings and terms. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
- Retrieved medical and financial text also reaches the selected chat provider at question time. Include that path in the data-flow description.
- Schema-constrained output can still contain false facts, and a browser agent can still misuse an allowed destination. Keep extraction credentials separate from browser credentials; constrain operations and network destinations in code.
- URL ingestion needs authenticated authorization, private-network/redirect protections, content-size limits, and rate limits before enabling fetching. Ingestion prompts are not an authorization boundary.
- “Local-only is a configuration” is unproven for the whole Convex, Next.js, identity, model, and connector stack. Describe it as a future deployment profile until independently installed and tested.

A single Mac worker is a reasonable owner-specific recipe. Dropbox is not inherently Mac-only: its remote API is another option. Requiring the entire cloud folder locally and an external SSD should remain a recipe choice, not a requirement for every adopter. Local OS extraction adapters cannot simply run inside the same pure TypeScript/Convex execution path.

## 7. Reproducibility and licensing start now

`AGENTS.md` requires an untracked private tracker and private plans before contributors can work. Split owner operations from a public contributor workflow with public issues, sanitized plans, and fixture-only tests. A clean clone must work without the owner's accounts, private documents, or preferred coding subscription. Agent-assisted setup can improve an ordinary documented install; it should not be the only definition of installation.

The README currently points plugin installation at the upstream marketplace. Verify and change that route before recommending it for a new private deployment, so it resolves the intended server. Publish implemented versus planned capabilities clearly.

MIT fits the stated permissive-sharing goal, subject to confirming the upstream grant. The local LICENSE asserts upstream portions are MIT, but the tracker records that the upstream root had no LICENSE and only plugin metadata declared MIT. Resolve the scope with upstream evidence or the author before treating repository-wide redistribution as settled. Adding a new LICENSE or resetting git history does not establish rights in inherited code. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

Provide a portable export of records, evidence, revisions, and schema versions. Define the Brain query/write contract independently from transport and provider adapters. This makes the claimed layer replaceability credible without rewriting the working Convex base today. Separate free source licensing from hosting and model API costs.

## 8. Choices to retain, qualify, or defer

| Choice or claim | Review |
|---|---|
| Extend the existing Brain | Reasonable because working memory and authentication code exist. “Nothing else has provenance” is an unsupported comparative claim without a cited survey. |
| Cloud lookup; ingestion can wait | Strong fit for mobile access. Keep source processing out of the normal answer path. Add exact/keyword lookup when embeddings are unavailable. |
| Cloud embeddings | Sensible for this hosted topology. A local model is not inherently tied to a home Mac; compatible models can be hosted elsewhere. |
| `text-embedding-3-large` at 1536 | Treat corpus superiority as a hypothesis to measure. Version the embedding configuration and prevent mixed old/new vectors during migration. Equal dimensions do not imply compatible vectors. |
| OCR and local-model speed/quality claims | “Best free OCR,” tokens per second, and comparative extraction quality need representative measurements, not confident prose. |
| Existing recall harness | Useful starting point, but it currently seeds fact/thought cases. Extend it for document chunks, exact fields, citations, and coverage before claiming it evaluates the new pipeline. |
| Backfill estimate | Keep as an accepted rough budget, not a measured forecast. Track actual pages, retries, OCR, extraction, embedding, and recurring costs during the pilot. |
| Portal browser automation | Pilot individual flows. Signed-in pages, embedded viewers, and exports differ; an extension does not automatically capture every portal faithfully. |
| Photos, meetings, messaging, repository inventory | Useful later. They should not delay reliable everyday family records. |

Plan cleanup also includes the stale “permanent name” question, the public tracker's wrong path, connector enum drift between documents, and Phase 1's blanket Sonnet-class delegation conflicting with the required judgment/security review tier.

## 9. Recommended next sequence and acceptance

1. Prove both native mobile query paths with synthetic records and the ingestion host off. Record account, app version, authentication, tool selection, and limitations.
2. Revise the family/entity, event/observation, provenance, coverage, and recovery contracts. Add exact query semantics and authorization tests before schema implementation.
3. Deliver one end-to-end path for each of a lab result, vehicle service, and workout. Include at least two family members and shared/private records.
4. Add reliable filesystem and email ingestion, monitoring, restore, and correction propagation. Then measure extraction and retrieval against a labeled pilot corpus before bulk ingestion.
5. Expand connectors. Maintain the public install recipe and synthetic demo throughout.

The first useful release must pass these product tests:

| Test | Required outcome |
|---|---|
| Repeated measurement | Equal workout loads on two dates remain two observations; “last” selects by event date. |
| Out-of-order import | An older result imported later never becomes the newest event merely because of ingestion time. |
| Family identity | Two members retrieve and update the same shared person and vehicle; “me” resolves independently. |
| Isolation and roles | Reader cannot write; private IDs/history/entities cannot be accessed; revocation blocks subsequent operations. |
| Answer without source access | Stored date/value/evidence is returned while the worker is off; original-file access is reported separately. |
| Incomplete archive | Missing periods and failed imports prevent an unqualified negative answer or complete total. |
| Corrected source | A revised record updates relevant derived facts/summaries while preserving the audit trail. |
| Worker interruption | Crash, retry, overlapping poll, and expired cursor produce no lost durable jobs or duplicate observations. |
| Recovery and portability | Restore/export preserves record identity and citations; a second person can install from public artifacts alone. |

Review acceptance: findings and sources recorded; no implementation or deployment is implied by accepting this report. The native mobile tests and representative-corpus benchmarks remain future work.

Verification: `pnpm lint`, `pnpm check-types`, `pnpm test:once`, and `pnpm build` passed on the review checkout. Lint reported 10 existing warnings and zero errors. Tests passed: 33 web, 75 database, and 9 script tests. `git diff --check` passed. No production records, migrations, deployments, mobile accounts, or live-corpus evaluations were exercised.
