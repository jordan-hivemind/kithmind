# Admin panel, sources and typed extraction

Date: 2026-09-18
Status: adopted direction. The owner decided the items in section 1. Everything
else is the orchestrator's recommendation and may change as screens are built.

## 1. Owner decisions

| Topic | Decision |
| --- | --- |
| Quality bar | A personal project, built well. Not enterprise software. The source files are the ultimate backup. No new hardening unless it blocks use. |
| Priority | Ingest real life data across many types, to test flexibility and precision. Outside investments first, then bank and card statements, other brokerages, medical records, vehicle service records, project receipts. |
| Operation | Long term the product is operated from its own UI, not from a coding agent. Adding a major new provider through a coding agent is fine, but the UI must show a complete inventory so gaps are visible. |
| Configuration | Out of JSON files and into the database: document types and fields, watched sources, mappings. |
| Watcher host | The always-on home machine is the long-term home of the filesystem watcher. The laptop is the interim host. |
| Moves and renames | Watched folders and files must self-repair when renamed or moved. No breakage, no duplicates. |
| Investments | Tracked in the app, not in a spreadsheet. The existing spreadsheet is imported once. Entry forms for capital calls, distributions and the like are the frequent path. |
| UI behaviour | Reactive. Edits apply optimistically with no refresh. Server-side changes appear live with no refresh. |
| UI style | White, gray and blue. Inter. Compact tables. Kebab menus for row actions. Everything sortable and filterable with search as you type. Tooltips for detail. Square tags. No explanatory prose in the UI. |
| Reviews | Second-model review only for sign-in, access control, MCP exposure and anything that changes financial numbers. |
| Runtime pins | Keep a recorded parser version so reprocessing is reproducible. Drop per-file hash manifests and config fingerprint ceremony. Updates are pull, build, restart. |

## 2. What exists and what does not

| Area | Today |
| --- | --- |
| Documents | Parsed to pages, chunks and cited evidence spans, embedded, searchable through MCP. PDF and xlsx only. |
| Typed extraction | Not running. The read side (events, observations, `query_records`) exists. Nothing writes to it since the move to PostgreSQL. |
| Watched sources | One private JSON config per source on the watcher host. The web app can only name and enable a source. |
| Document types | TypeScript constants. Not visible or editable. |
| Finance archive | One institution, strict typed records, its own read contract. Unchanged by this plan. |
| Web app | Next.js 15, React 19. Pages: browse, settings, spaces, getting started. No admin panel. No live updates. |

## 3. Stack

| Piece | Choice | Why |
| --- | --- | --- |
| App | The existing Next.js app | Sign-in, spaces and the store are already wired. |
| Styling | Tailwind plus a small set of accessible primitives (menu, tooltip, dialog, drawer) | Matches the style decision with little code. |
| Tables | TanStack Table | Sorting, filtering, search, grouping and expandable rows from one headless component. |
| Client state | TanStack Query | Optimistic mutations with rollback, and targeted refetch. |
| Live updates | A change feed (section 4) | PostgreSQL and serverless hosting give no subscriptions on their own. |

## 4. Change feed

1. A `kith.changes` table: monotonically increasing id, space id, table name, row id, operation, committed at.
2. Triggers on the tables the UI shows write one row per insert, update and delete. Rows older than a few days are pruned by the deferred-work daemon.
3. `GET /api/kith/changes?since=<id>` streams server-sent events for the caller's authorized spaces. It falls back to a short poll with the same cursor when the stream drops.
4. A client hook maps each change to the query keys it invalidates.

Access control: the route uses the same session and space authorization as every other route, and returns ids and table names only, never row content. This route gets a second-model review.

## 5. Data model additions

| Table | Holds | Notes |
| --- | --- | --- |
| `document_types` | kind, description, area, extraction guidance, examples, version, active | Editing creates a new version. Extracted documents record the version they used. |
| `document_type_fields` | type id, field name, value type, required, check (on page, exact, sums to total), example | Value types: text, organization, person, date, money, number, identifier, line item list. |
| `source_roots` | source account id, kind (folder, institution, manual), provider folder id, last known path, expected types, area, state | The desired list. The watcher pulls it each pass. |
| `source_root_reports` | what the watcher host sees: available top-level folders, counts, skipped files with reasons, last pass, problems | Written by the watcher, read by the UI. |
| `investments` | entity id, category, signed date, status, notes | One row per investment. |
| `investment_entries` | investment id, entry type, date, amount, currency, exchange rate, note, document id, evidence span | Capital call paid, distribution, commitment, commitment change, fee, write-off. Totals are computed, never stored. |
| `corrections` | target (document, field or record), original value, corrected value, actor, reason, time | The original reading is kept. Reads prefer the correction. |
| `changes` | section 4 | |

Statements produced by extraction are ordinary observations with evidence spans, so `query_records`, coverage and citations keep working.

## 6. Sources that repair themselves

| Case | Behaviour |
| --- | --- |
| Watched folder renamed or moved | The source is keyed by the provider's folder id. The watcher resolves the id to the current path each pass and updates `last known path`. Nothing is re-ingested. |
| File renamed or moved inside a source | Keyed by provider file id. Same document, new location recorded. |
| File copied to a second place | Same content hash, different file id: recorded as a duplicate of the first, not a second document. |
| File moved out of every source | Marked unavailable, then retired after a grace period. The archived original is kept. |
| Provider id unavailable (non-provider folder) | Fall back to content hash plus size. A rename looks like a removal and an addition with the same hash, and is joined. |
| Folder deleted | The source shows a problem in the UI. Nothing is deleted. |

The watcher host keeps one local setting: the top-level directories it may read (for example the synced provider folder). A database row can never point it outside them.

## 7. Watcher host

| Step | Detail |
| --- | --- |
| Interim | The laptop keeps running the watcher. |
| Move | Install the provider's sync client and the worker checkout on the always-on machine, create a worker credential for it, copy the journal and archive catalog once, start the LaunchAgent there, stop the laptop's. |
| After | The laptop is a client only. The health page shows which host is watching and when it last passed. |

## 8. Extraction

One pass per document over the sealed text produces typed statements: party, date, money, identifier, line item, term. Each carries its evidence span and a confidence, plus a kind label and a one-line summary. Checks are per value type, not per kind: a value must appear in the cited text, money and dates must parse exactly, line items must sum to a stated total where both exist. A failed check opens a correction item instead of storing a guess. Kinds are rows in `document_types`. Adding a kind is a row, not a release. Editing guidance bumps the version and re-extraction is on demand. Image receipts are normalized to PDF before intake and go through OCR. Strict typed records remain for ledgers and statements, fed by deterministic parsers or by extraction with arithmetic checks.

Dropped from the earlier card design: closed kind enums, the model tier ladder, weekly budgets and the pausing queue, the rule that a source publishes nothing until a subject entity exists, and the entity binding gate. Names are stored as written and bound to entities later.

## 9. Screens

| Order | Screen | Shows |
| --- | --- | --- |
| 1 | Health | Checks with plain status. Same content as the daily report. |
| 2 | Sources | Every folder, institution and manual source: location, area, items, skipped, last read, status. Add folder. |
| 3 | Institutions | Institutions as expandable groups over their accounts: statements, activity range, latest snapshot, open reviews, status. |
| 4 | Coverage | Life areas against sources, documents, records, date range and gaps. |
| 5 | Investments | Investments with computed committed, sent, outstanding and received, expandable into entries. Add entry is the primary action. Import from a spreadsheet is a secondary action. |
| 6 | Types and fields | Kinds, their fields, checks, guidance, versions. Edit and re-extract. |
| 7 | Corrections | Open and resolved items with the original reading and the fix. |

## 10. Build order

| Step | Delivers | Usable result |
| --- | --- | --- |
| 1 | Schema for section 5, change feed, UI foundation (Tailwind, table, query cache, live hook) | Nothing visible yet. |
| 2 | Health, Sources, Institutions, Coverage, read-only and live | An inventory of everything the system reads, with gaps. |
| 3 | Investments: tables, entry forms with optimistic saves, one-time spreadsheet import, MCP read tools | Exact answers about commitments, calls and distributions. |
| 4 | Sources write path: add folder, provider ids, self-repair, watcher pulls `source_roots` | New folders added from the UI. |
| 5 | Extraction writer, types and fields screen, corrections | Typed, cited answers from documents and receipts. |
| 6 | Watcher moves to the always-on host | Ingestion independent of the laptop. |

## 11. Acceptance for the first use case

Through the MCP connector the owner can ask, and get exact, cited answers to: committed versus sent versus outstanding per investment, which investments returned capital, exposure by category, what was signed with a given company and its key terms, and the tax forms for a given year.
