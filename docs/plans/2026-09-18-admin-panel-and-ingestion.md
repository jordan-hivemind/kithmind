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

The `sums_to_total` check spans two fields, so it needs one naming convention. A document type whose field carries that check states the sum in a money field named `subtotal`, or in one named `total` when the type has no subtotal. The preference matters on a taxed receipt: the items sum to the subtotal and the total carries the tax. A type that names its sum anything else gets no sum check, which is the same as declaring none.

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

## 12. Linking investment documents (ADM-3)

The owner does not file documents by hand: he enters the investment dollars
and drops the supporting files in the watched Investing folder. Step 3 built
the entry side of that and the suggestion side of it. Step 5's extraction
writer supplies the rest, and this section fixes the rule so that step does not
have to re-decide it.

### What exists now

| Piece | Behaviour |
| --- | --- |
| `investment_entries.document_id` | Optional. One entry cites at most one document. |
| `suggestDocumentsForEntry` | Computed on read, never stored. Ranks the space's published, unlinked documents by three signals: the investment's name in the document title (3), an exact string form of the entry amount in its text chunks, tried as `25000.00`, `25,000.00`, `25000` and `25,000` (2), and a capture date within 45 days of the entry date (1). A document scoring zero is not offered. |
| Unlinked count | Per investment: published documents whose title contains the investment's name and that no entry links to. The screen shows it as a gap, not a total. |
| Upload | Present and disabled, with the tooltip "Drop files in the watched Investing folder". |

### The automatic rule, for when extraction lands

An extracted document is linked to an entry without asking when all four hold:

1. The document's kind is a capital call notice or a distribution notice.
2. An extracted party matches the investment's `entities` row, by the entity
   the investment already points at or by the same exact normalized name.
3. An extracted money value equals an entry's amount exactly, in the same
   currency. No tolerance: an amount that does not match is not this document.
4. The document's stated date is within 45 days of that entry's date, and
   exactly one entry of the matching type satisfies 2 to 4.

Anything short of that is a suggestion, not a link. In particular: two entries
matching the same document, an amount matching no entry, a party matching no
investment, or a kind outside the two above. A document that is already linked
is never relinked, and a link is only ever added to an entry whose
`document_id` is null, so a correction the owner made by hand outranks the
rule.

Uploads later write into a managed subfolder of the watched provider folder
rather than into a second intake path, so the watcher stays the one way a
document enters the system and a file added from the UI is ingested, hashed and
deduplicated exactly like one dropped in by hand.

### Totals

| Total | Rule |
| --- | --- |
| committed | `commitment` plus `commitment_change` |
| sent | `capital_call_paid`, and only that |
| fees | `fee`, its own total, never folded into sent |
| received | `distribution` |
| outstanding | committed minus sent, **signed** |
| overCalled | sent minus committed when that is positive, else zero |

`outstanding` is signed rather than floored at zero: flooring made an
over-called fund read exactly like a fully called one, and an over-call is the
case the owner most needs shown. The screen renders it as an `over-called` tag
with a tooltip.

Only a `commitment_change` may be negative. Every other type carries its
direction in the type, so a negative capital call would subtract from `sent`.
The rule is enforced in the request schema, in the store, and by
`investment_entries_amount_sign_check` in migration 025.

Per-currency totals keep the money column's own precision. The USD totals are
converted with each entry's own recorded rate and rounded to two places once,
after the sum.

An investment's entries are read when its row is expanded, not with the list,
so the screen's cost is the number of investments rather than the number of
capital calls ever paid.

### Import

The one-time spreadsheet import takes CSV exports of the `Summary` and `Ledger`
tabs, client side, with no Google API. Its sign and currency rule is stated in
the preview the operator approves: the sign comes from the `Amount` (USD)
column when it has a value and from `GBP` otherwise, negative being money out
(capital call paid) and positive money in (distribution); a value in the `GBP`
column makes the entry GBP with that column as its amount and `Exchange Rate`
as the rate to USD, and otherwise the entry is USD. Every type can be flipped
per row before importing.

Each GBP row is checked against the sheet's own USD `Amount`: GBP times rate
must agree within 1% or $1, and a row outside that is flagged as a rate that
looks inverted or wrong. The preview then reconciles each investment's imported
entry totals, in USD and including the GBP rows, against the `Summary` tab's
own `Sent` and `Received`, and reports differences rather than trusting either
side. Import stays disabled until the operator acknowledges any difference,
flagged rate or unimportable row, and every row ends the run reported as
created, already imported, or failed with a reason.

The import is idempotent: each source row carries a stable key stored on the
entry (`investment_entries.import_key`, migration 025) that includes an
occurrence ordinal, so two genuinely identical rows are two entries while a
second import of the same file creates nothing. A row corrected in the sheet is
a different row and imports as a new entry; the preview says so, and the old
entry is deleted by hand.

A `Summary` row with a committed amount but no `Docs Signed` date is reported
as unimportable rather than given today's date: a fabricated date in a
financial record is worse than a missing entry.

## 12. Extraction knobs (ADM-5d)

The model reads a page as numbered lines and cites line ids rather than
copying text. The server builds the quote from the cited lines, so a citation
is checkable arithmetic and the value gates run against the page's own words.

**Pages and lines are both 1-based in the prompt, and neither is the page's
own ordinal.** `source_pages.ordinal` is 0-based and may be sparse; a page's
number in the prompt is its position in the list actually shown, and citations
resolve only through that map. A page with no words on it is not shown, which
shifts nothing because there is no hole to shift over. A cited page that is not
in the map is `citation_page_unknown` and nothing is shifted to make it fit.

A line longer than 240 characters is split into citable pieces at whitespace,
with exact offsets, so a 2,000-character line does not become one citation
holding dozens of numbers.

**Cited lines need not be adjacent.** A column receipt prints its labels in
one block and its amounts in another, so the only honest citation of a total
is two lines several apart. The value is checked against each cited line on
its own, never against the lines between them, so an unrelated amount in
between can never support a value. A value must sit entirely inside one cited
line; only a text field may span two adjacent cited ones, and only a text
field is matched case- and punctuation-folded. Money, numbers and dates keep
their exact reading.

Every stored statement and every gate correction records what it cited: shown
page, page ordinal, line ids, the page's line count and whether the ids are
contiguous. `kith-extraction-diagnose [--kind k] [--limit N]` reads those back
and reports, per failure, whether the value occurs on the cited page and on
which line ids, whether it occurs on another page, and the character-class
signature of the value. Its output is integers, booleans, enum reasons and
field names only: operators debug extraction without reading the documents.

| Knob | Where | Effect |
| --- | --- | --- |
| `KITH_EXTRACT_MODEL` | daemon environment | The default model. Unchanged. |
| `KITH_EXTRACT_ENDPOINT` | daemon environment | OpenAI-compatible chat completions. A 4xx on the JSON-schema request falls back to plain JSON for the rest of the run. |
| `KITH_EXTRACT_API_KEY` | daemon environment | Falls back to `OPENAI_API_KEY` on the default endpoint. |
| per-kind model | `document_types.examples`, an element `{"setting": "extraction_model", "value": "<model>"}` | That kind is read with that model. A kind without one uses the default. A model the provider refuses falls back to the default for that run and opens one `extraction_model_refused` item. |
| per-kind date order | `document_types.examples`, an element `{"setting": "date_order", "value": "MDY"}` or `"DMY"` | How that kind writes an all-numeric date. |

A per-kind override costs one extra call the first time a document is read,
because the kind is not known until the reply names it; a re-extraction knows
the kind already and costs one call. Nothing here picks a model.

Two-digit years in a printed date expand 00-69 to the 2000s and 70-99 to the
1900s.

An all-numeric date whose first two numbers could both be a month is read only
when the kind sets `date_order`. `01/02/26` is the first of February or the
second of January and the string cannot say which, so unset it opens a
`date_ambiguous` correction rather than storing a coin flip. A date that
settles itself needs no setting: `13/02/2026` has no thirteenth month,
`9 Apr 26` names it, and an ISO date is an ISO date. The owner's documents are
overwhelmingly US, so `MDY` is the likely setting, but it is the owner's to
make per kind.

A space inside a number is closed up only next to a currency symbol or an ISO
code, so `$ 165 .00` reads as one amount while `APPLES 12 .99` stays a quantity
beside a price. A column-rendered amount with no currency mark beside it opens
a correction instead, which is the cheaper of the two errors.
