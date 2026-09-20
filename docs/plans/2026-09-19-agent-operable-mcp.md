# Agent-operable MCP server

Date: 2026-09-19. Status: design, not adopted.

> Amended 2026-09-20: sensitivity re-scoped by the owner, see PR #319.
> Section 6's consent-screen default is corrected from sensitivity `normal`
> to `restricted` (full access), matching the shipped ceiling default.
> Section 8's slice 8 no longer includes redaction at the read boundary,
> which was proposed for the sensitivity work and rejected by the owner.
> Open question 1 is resolved: the owner's three levels shipped, `restricted`
> is not confined to the admin UI, and every credential's default ceiling is
> full access. Domain grants remain proposed, unbuilt work.

Goal: an assistant with only an MCP connection can run Kith Mind. It writes as
well as reads, and it learns the vocabulary from the server, never from the
code. Silent wrong data is the one unacceptable failure. Never nag for
information the owner does not have.

## 1. Inventory and gap analysis

Nineteen tools are registered today. Registry `apps/web/src/lib/mcp/tools.ts`,
annotations `tool-policy.ts`, handlers and descriptions `server.ts`, read
bodies `reads.ts`, write bodies `writes.ts`, all under
`apps/web/src/lib/mcp/`.

| Tool | Nature | Touches |
| --- | --- | --- |
| `list_spaces` | read | `identity/spaces.ts` `listSpaces` |
| `recall_context` | read | facts and thoughts blend, `reads.ts` |
| `search_facts` | read | `memory/facts.ts` `listFacts` |
| `search_thoughts` | read | `embeddings/search.ts` |
| `browse_recent` | read | `memory/thoughts.ts` `listBySpaces` |
| `get_thoughts` | read | `memory/thoughts.ts` `getThoughtsByIds` |
| `timeline_thoughts` | read | thought index by time |
| `get_stats` | read | space counters |
| `search_documents` | read | `documents/model.ts` `searchDocuments` |
| `get_document` | read | `documents/model.ts` `getDocument` |
| `list_sources` | read | `documents/model.ts` `listSources`, finance coverage |
| `list_inventory` | read | `documents/inventory.ts` `listInventory` |
| `list_review_queue` | read | `records/reviewQueue.ts` `listReviewQueue` |
| `query_records` | read | `records/query.ts`, finance archive |
| `list_investments` | read | `admin/investments.ts` `listInvestments` |
| `get_investment` | read | `admin/investments.ts` `getInvestment` |
| `remember_fact` | write | `memory/facts.ts` `rememberFact` |
| `capture_thought` | write | `lib/kith/capture.ts` gate, `memory/thoughts.ts` |
| `ingest_url` | write | `ingestion.enqueueSourceFetch` |

Three writes, sixteen reads. Every owner action below exists in the web UI or
in an adopted plan and has no tool.

| Owner capability | Where it exists | MCP gap |
| --- | --- | --- |
| Create, edit, archive an investment | `api/kith/investments/route.ts` POST/PATCH/DELETE, `admin/investments.ts` `createInvestment`, `updateInvestment`, `archiveInvestment` | no tool |
| Create, edit, delete an entry | `api/kith/investments/[id]/entries/route.ts`, `createInvestmentEntry`, `updateInvestmentEntry`, `deleteInvestmentEntry` | no tool |
| Suggest documents for an entry | `api/kith/investments/[id]/suggestions/route.ts`, `suggestDocumentsForEntry` | no tool |
| Link states and confirm or reject | planned in `docs/plans/2026-09-19-investment-document-matching.md`, migration 028 | not built anywhere |
| Attention items, dismiss, snooze | same plan, `kith.corrections` widened | not built anywhere |
| Edit or retire a fact | `api/kith/facts/[id]/route.ts`, `memory.updateFact`, `memory.retireFact` | no tool |
| Edit or retract a thought | `api/kith/thoughts/[id]/route.ts`, `memory.updateThought`, `memory.deleteThought` | no tool |
| List and add source folders | `api/kith/source-roots/route.ts`, `admin/model.ts` `listSourceRoots`, `upsertSourceRoot` | `list_sources` reports accounts, not roots |
| Re-extract a document | `extraction/model.ts` `scheduleReextraction` | no route and no tool |
| Corrections | `extraction/corrections.ts` `openCorrection`, `applyCorrection` | no route and no tool |

Two dependencies matter. Link lifecycle and attention items are design, not
code: `admin/investments.ts` carries one nullable `documentId` per entry and
`suggestDocumentsForEntry` returns unpersisted suggestions. `identity` and
`extraction` are not re-exported from `packages/kith-store/src/index.ts`.

## 2. Tool design principles

The reader of a tool schema is a model with no repository. Everything it needs
is in the name, the description, the enum labels and the result.

| Principle | Rule |
| --- | --- |
| Task shaped | One tool per owner intent, not per table. `record_investment_entry` does the investment, the entry and the document search in one call. |
| Idempotent | Every write takes `writeKey`. `createInvestmentEntry` already has `importKey`; the same column serves. A repeat returns the first result with `repeated: true`. |
| Preview | Every write takes `dryRun`, which returns the exact `changes` array the real call would apply and writes nothing. |
| Result says next | Every result carries `changes`, `state` and `nextSteps`. `nextSteps` is for the agent, not the owner. |
| Closed enums | Every enum value carries a one-line `.describe()`. `entryType` never accepts free text. |
| Money | Decimal strings with a separate ISO 4217 `currency`, never a number. Matches `records/values.ts` and the `numeric` columns. |
| Dates | `YYYY-MM-DD` for calendar dates, timezone-qualified ISO 8601 for instants. Relative dates are refused. |
| No SQL | `query_records` stays a validated shape. No tool accepts SQL. |
| Errors name the fix | `CLIENT_SAFE_TOOL_ERRORS` in `server.ts` grows a second class of fixed literals that say what to change and name nothing stored. |

Annotations and consent, by group.

| Group | readOnly | destructive | idempotent | Capability |
| --- | --- | --- | --- | --- |
| Reads and previews | true | false | true | `read` |
| Additive writes | false | false | true | `read` + `write` |
| Correcting writes | false | false | true | `read` + `write` |
| Archive and retire | false | true | true | `read` + `write` |
| `undo_write` | false | false | true | `read` + `write` |

A dry run keeps `readOnlyHint: false`, because an annotation describes the
tool and not one argument. The description says `dryRun` writes nothing.

## 3. Glossary and instructions

Three deliveries, in descending order of how reliably clients honor them.

| Surface | Honored by | Depend on it |
| --- | --- | --- |
| Tools | every MCP client | yes |
| Server `instructions` | clients that surface server instructions, including Claude Code and the Claude desktop app | yes, for routing only |
| Resources and prompts | uneven, and the deployment advertises `capabilities: ["tools"]` today in `api/mcp/discovery/route.ts` | no |

So the glossary lives in `get_glossary` and `get_instructions`, which every
client can call. Resources may mirror them later. Nothing may exist only
there.

Proposed `SERVER_INSTRUCTIONS`, replacing the long text in `server.ts`. It
routes and nothing else.

> Kith Mind is a personal and family knowledge system: facts, narrative
> memory, indexed documents, investments and taxes.
>
> Call `get_instructions` with a domain before your first write in that
> domain, and `get_glossary` when a term is unfamiliar. Domains: memory,
> people, documents, investments, taxes, attention, sources.
>
> Routing. Personal or relationship context: `recall_context`. A precise
> single fact: `remember_fact`. A decision or project state: `capture_thought`.
> A question about a document: `search_documents`, then `get_document`. Money
> received, sent or committed to an outside investment:
> `record_investment_entry`. What the owner should look at:
> `list_attention`.
>
> Rules that hold everywhere. Never guess an identity. If a name matches more
> than one thing, or nothing, ask the owner and do not create a second entry.
> Preview a write with `dryRun: true` when you are unsure, then repeat the
> call with the same `writeKey`. Money is a decimal string with a currency,
> never a number. Dates are `YYYY-MM-DD`. Never ask the owner for something
> they may not have: say what is missing and stop. This server never moves
> money, never trades, and never handles credentials.

`get_instructions(domain)` returns 200 to 600 words per domain: what the
domain holds, which tools in which order, what to do when ambiguous, what
never to do. `get_glossary(domain, term?)` returns entries. Both are static
text, versioned with the tool surface, and both are read-only.

### Investments glossary, in full

| Term | Meaning |
| --- | --- |
| investment | One outside position: an angel investment, a fund, or a syndicate. It has a name, an optional category, an optional signed date, and a status of `active`, `closed` or `written_off`. Every amount belongs to an entry, never to the investment. |
| entry | One dated money event against one investment. `entryType` is `commitment`, `commitment_change`, `capital_call_paid`, `distribution`, `fee`, `write_off` or `other`. The type carries the direction, so every amount is positive except `commitment_change`, the one type that may be negative. |
| commitment | The amount promised to a fund, recorded once when the agreement is signed. It is a promise, not a payment. A later change to the promise is a `commitment_change`, positive or negative, never an edit to the original. |
| capital call paid | Money actually sent to the fund against the commitment. Use this when the owner says they sent, wired or paid. It never changes the commitment. |
| distribution | Money received back from the investment. Always positive. |
| outstanding | Committed minus sent. It is signed and not floored. A negative outstanding means the fund called more than was committed. |
| over-called | The same excess as a positive number, `0.00` when there is none. Report it as given. |
| estimated date | The entry date was inferred, not read from a document. `date_is_estimated` is true. When a linked document later supplies a real date, the system replaces it and records a correction. Do not ask the owner for an exact date. |
| supporting document | The file that evidences an entry: a capital call notice, a wire confirmation, a distribution notice or an agreement. Documents arrive only through a watched folder. The file name does not matter. |
| link state `auto_linked` | The system matched a document to an entry on its own, on party, amount, date and path evidence, with no competing candidate. Treat as true. |
| link state `suggested` | A plausible match that no one has confirmed. Never treat a suggestion as evidence. Show it to the owner or confirm it against the document's own content. |
| link state `confirmed` | A person accepted the link. Highest trust. |
| link state `rejected` | A person refused the link. The pair is never proposed again. Rejections are kept, never deleted. |
| attention item | Something the system noticed and cannot settle alone: a payment with no document, a notice with no entry, a call due and unpaid, a date or amount that disagrees, an over-called fund. It carries a `class` of `money_at_risk`, `system_breakage`, or none for the quiet queue. |
| dismissed | The owner decided this item is not worth acting on. The detector never reopens that key. Use when the owner says to forget it. |
| muted | The owner switched off a whole class of items, by detector, by investment, or before a date. Use for "stop telling me about X". |
| snoozed | Hidden until a date. The item returns. Use only when the owner names a time. |

### Other domains, outlined

| Domain | Entries it defines |
| --- | --- |
| memory | fact, predicate, cardinality, single-valued history, `changed` against `corrected`, thought, core, superseded, retracted, space. |
| people | subject key, alias, `me`, entity kinds, why a person is resolved before a fact is written, what a near match means. |
| documents | source item, revision, document, page, evidence span, citation, extraction, typed statement, gate, correction, re-extraction. |
| taxes | return identity of `draft`, `filed`, `amended`, authoritative, semantic key, line reference, fact state of `verified`, `unverified`, `disputed`. |
| attention | the detectors, the queue classes, resolve against dismiss against snooze against mute. |
| sources | watched folder, source root, source account, where to drop a file, why file names do not matter, when matching runs. |

## 4. Worked examples

### "I just invested $200 in [fund]"

Step 1, resolve. `resolve_investment({ name: "<fund>" })` is read-only.

```json
{ "matches": [ { "investmentId": "inv_x", "name": "Fund Two",
  "confidence": "exact", "status": "active", "committed": "25000.00",
  "currency": "USD" } ], "ambiguous": false }
```

Two matches, or a fuzzy match only, returns `ambiguous: true` with the
candidates and `nextSteps: ["Ask the owner which one. Do not create a new
investment."]`. No match returns `matches: []` and a next step to ask whether
this is new, because creating one silently produces a near-duplicate. The
agent asks. It never guesses.

Step 2, classify. The glossary decides it. An existing commitment plus the
words sent, wired or paid means `capital_call_paid`. New money with no prior
commitment means a new investment plus a `commitment`, or a
`capital_call_paid` if the owner says the money is already gone. When the
sentence does not decide, the agent asks one question naming both readings.

Step 3, preview.

```json
{ "name": "record_investment_entry", "arguments": {
  "investmentId": "inv_x", "entryType": "capital_call_paid",
  "amount": "200.00", "currency": "USD", "entryDate": "2026-09-19",
  "dateIsEstimated": true, "writeKey": "conv-8812-1", "dryRun": true } }
```

Result: `changes: [{ kind: "entry", op: "create", ... }]`, `applied: false`,
plus the totals the entry would produce.

Step 4, create. The same call with `dryRun: false`.

```json
{ "applied": true, "writeKey": "conv-8812-1", "entryId": "ent_9",
  "state": { "committed": "25000.00", "sent": "200.00",
    "outstanding": "24800.00", "overCalled": "0.00", "currency": "USD" },
  "supportingDocuments": { "searched": 4120, "linked": [], "suggested": [] },
  "filing": { "watchedFolder": "Investing",
    "note": "Drop the wire confirmation or capital call notice anywhere in
      the watched Investing folder. The file name does not matter." },
  "nextSteps": [
    "No supporting document exists yet. Tell the owner where to drop it once.",
    "Matching runs when the document arrives and links it automatically.",
    "Do not ask again."] }
```

The document search is part of the create result, not a second call, because
the agent would otherwise have to know to make it. When a document is found,
`linked` or `suggested` is populated and `nextSteps` says to confirm.

Step 5, later. `decide_document_link({ entryId, documentId, decision:
"confirm" | "reject", reason?, writeKey })`. Confirm sets `confirmed` and may
replace an estimated date. Reject sets `rejected` and suppresses the pair
forever. Repeating a decision is a no-op.

### "remember that [family member] changed schools in [month]"

`resolve_person({ name })` first, returning the subject key and aliases, or
`ambiguous: true`. Then `remember_fact` with that subject key, `predicate:
"school"`, a text value, `validFrom` set to the first of the named month,
`cardinality: "single"`, `changeKind: "changed"`. The prior school becomes
history automatically. `corrected` is only for a value that was wrong. The
month is a real `validFrom`, so no estimate flag is needed and the agent does
not ask for the day.

### "what needs my attention", then "forget the missing-document items for [fund]"

`list_attention({ classes: ["money_at_risk"], includeQuiet: true })` returns
items grouped by class, each with a one-line reason and a citation.

The second utterance is a mute, not a dismiss, because it names a whole class
for one investment. `resolve_attention({ action: "mute", scope:
"detector_for_investment", detector: "entry_without_document", investmentId:
"inv_x", writeKey })`, previewed first because a mute suppresses future items.
The result reports how many open items closed and that the detector will not
reopen for that investment.

## 5. Write safety

| Class | Examples | Gate |
| --- | --- | --- |
| Free | create entry, create investment, remember fact, capture thought, confirm or reject a link, resolve or snooze an attention item, correct an extracted value, re-extract a document | idempotent, additive, reversible, no confirmation |
| Preview then confirm | archive an investment, retire a fact, retract a thought, delete an entry, mute a detector, add a source folder | agent must call `dryRun: true` first and echo the result to the owner |
| Never exposed | hard delete, space and membership changes, invitations, API key create or revoke, sensitivity ceiling changes, source folder removal or relocation, anything that moves money or trades | not registered as tools at all |

Every exposed removal is a soft reversal. `retireFact` sets `valid_to`,
`deleteThought` sets `memory_status = 'retracted'`, `archiveInvestment` takes
an `archived` flag that restores. Nothing an agent calls removes a row.

Undo. `kith.agent_writes` records one row per applied write: credential, tool,
`writeKey`, target, inverse operation, time. `undo_write({ writeId? })`
reverses the last write, or a named one, for this connection only, within the
last 20 writes and 24 hours. Each reversal runs through the existing history
mechanism, so the undo is itself a logged write.

The owner sees an agent activity table in the admin panel reading that log:
time, connection, tool, what changed, and an undo button.

Rate limits per credential: 60 writes an hour, 10 an hour in the
preview-then-confirm class, 300 reads an hour. Over the limit is a refusal
naming the limit and its reset, never a silent drop.

## 6. Authorization

Capabilities today are `read`, `write` and `ingest`
(`identity/authorization.ts`), granted per key with space and source-account
grants. The consent screen offers `read` and `write` (`oauth-validation.ts`).
That is too coarse for a connection that can create financial rows.

Proposal: keep the three capability strings as the storage primitive and add
`kith.api_key_domains` holding `(key_id, domain, mode)`, domain being memory,
people, documents, investments, taxes, attention or sources, mode being `read`
or `write`. A tool declares its domain and mode. The domain check runs beside
`requireSpaceAccess`, in the same transaction, from the reloaded principal.
Space scoping is unchanged: writes resolve one destination through
`resolveWriteSpace`.

A write tool must not become a read oracle for data the ceiling withholds.
Two rules. A dry run against a target above the ceiling is refused whole, in
the same words as a read refusal. A write result never echoes a field the
caller could not read, so "already exists" and "no such thing" are worded
identically.

The consent screen gains a domain matrix, keeping the space picker from
`consent-spaces.ts`, and already carries the maximum sensitivity selector
PR #319 shipped. Defaults: read everywhere, write nowhere, sensitivity
`restricted` (full access, matching the shipped ceiling default), narrowed
by the owner per connection, never narrowed by default.

`apps/web/src/lib/mcp/*` and `packages/kith-store/src/identity/*` are tier 2
work and need a second-model security review before merge, per AGENTS.md.

## 7. Testing an agent-operable server

Conformance suite, under `apps/web/src/lib/mcp/conformance/`. A script drives
the server over the real transport with a test credential, using only what the
instructions and glossary say. Golden transcripts: an utterance, the expected
tool sequence, the expected argument shapes, the expected result fields. It
fails when a description changes and the transcript does not, which is the
drift that makes a server unusable without the code.

Eval. A model with only MCP access, no repository and no plan files, gets ten
owner utterances: the three above, an ambiguous fund name, an unknown fund, a
statement that could be a commitment or a call, a correction of an earlier
fact, a document that should be rejected, a mute, and a request to delete
something no tool exposes. Scored on correct writes, zero duplicate
investments or entries, asking when ambiguous, and never claiming a write it
did not make. The bar is ten of ten on duplicates and on asking.

## 8. Build order

| Slice | Work | Depends on | Testable after |
| --- | --- | --- | --- |
| 1 | `get_instructions`, `get_glossary`, new `SERVER_INSTRUCTIONS` | none | routing transcripts, no writes needed |
| 2 | Write envelope, `writeKey`, `dryRun`, `kith.agent_writes`, `undo_write` | none | idempotency and undo on `remember_fact` |
| 3 | `resolve_investment`, `record_investment_entry`, `update_investment_entry`, `archive_investment` | 2 | worked example one through create |
| 4 | `find_supporting_documents`, `decide_document_link` | matching plan link table | link states end to end |
| 5 | `list_attention`, `resolve_attention` | attention items in matching plan | example three |
| 6 | `resolve_person`, fact correct and retire, thought update and retract | people profiles | example two |
| 7 | `list_source_folders`, `add_source_folder`, `reextract_document`, `correct_extracted_value` | 2 | filing guidance is real, not prose |
| 8 | Domain grants, consent matrix, on top of the per-connection ceiling PR #319 already shipped. No redaction at the read boundary: the owner rejected that design, and a lowered ceiling filters and counts rather than refuses | sensitivity work | domain refusals, oracle tests |
| 9 | Conformance suite and the ten-utterance eval | 1 to 8 | the whole surface |

Each slice is three to six agent hours. Slices 1, 2 and 7 depend on nothing
unbuilt and can start now. Slice 3 is usable without 4, since an entry with no
document is the common case.

## 9. Open questions

1. Sensitivity levels. Resolved by PR #319: the owner's three levels,
   `normal`, `sensitive`, `restricted`, shipped. `restricted` is not confined
   to the admin UI; it is readable through MCP like any other level, and the
   default ceiling (`restricted`, meaning everything) reads it in full. Only
   a ceiling the owner has deliberately lowered withholds a `restricted`
   document, and even then only for the reads listed in PR #319 (document
   search, document fetch, inventory, the review queue and record queries),
   not for thoughts, facts, investments, sources or stats.
2. Domain grants. Adding `kith.api_key_domains` is a migration and a consent
   screen change. Recommended default: build it, because a connection that can
   create financial rows should not also be able to write family facts unless
   the owner said so.
3. Undo window. Recommended default: last 20 writes, 24 hours, per connection.
4. New investment creation by an agent. Recommended default: allowed, but only
   after `resolve_investment` returned no match and the call carries
   `confirmedNew: true`, which the agent may set only after asking.
5. Estimated dates on agent writes. Recommended default: always set
   `dateIsEstimated: true` when the owner did not state a date, and never ask
   for one.
