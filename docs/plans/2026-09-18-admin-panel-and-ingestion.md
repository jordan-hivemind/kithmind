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

## 13. Extraction and the parsed seal (ADM-5i)

The payload manifest seals the **parsed** payload: the pages, spans, documents
and chunks the parser produced. Typed extraction is a derived layer written on
top of an already-activated generation, and its rows must not count against
that seal.

| Row | How the seal knows it is extraction's |
| --- | --- |
| Event version, observation | `event_type = 'document_statement'` |
| Evidence span, written from ADM-5i on | `locator->>'kind' = 'extraction_v1'` |
| Evidence span, written before that | Referenced only by a `document_statement` observation's `value_evidence` or that event version's `field_evidence` |

A span the manifest lists is never excluded, whatever points at it: extraction
reuses a parser span when one already covers the range, and excluding it would
turn a reused span into a missing one. The seal still refuses a foreign span, a
missing or altered parsed row, and any event version or observation on the
generation that is not extraction's.

### Orphaned extraction spans (ADM-5j)

The rule above recognises an extraction span by its marker or by what points at
it, so a span with neither is a foreign span and the generation fails to
verify. Extraction produced exactly that, twice over: it mints a span per cited
line before it knows the statement survives, and a re-extraction replaces the
previous run's observations without removing the spans they cited.

The extraction write path therefore ends with a sweep, in the same transaction
as the write: every `extraction_v1` span on the document's text version that
nothing references is deleted. Legacy spans stranded before the marker existed
are removed once by `kith-extraction-span-cleanup`, which is a dry run by
default, is bounded and transactional per generation, and reaches only spans on
a sealed text version whose locator has no kind or the `extraction_v1` kind.

Both halves use one reference whitelist, read off the schema rather than
inferred. A span named by any of these is never removed:

| Table | Column |
| --- | --- |
| `processing_generation_payload_manifests` | `evidence_span_ids` |
| `observations` | `value_evidence` |
| `event_versions` | `field_evidence` |
| `documents` | `evidence_span_ids` |
| `chunks` | `evidence_span_ids` |
| `worker_parsed_stages` | `evidence_span_ids` |
| `investment_entries` | `evidence_span_id` |
| `document_extractions` | `statements[].evidenceSpanId` |

A span carrying `card_extraction_fingerprints` is the card runner's and is out
of scope. `corrections` names a document, a field or an observation key and
holds no span id. A whitelist rather than a foreign-key sweep because
`investment_entries.evidence_span_id` is `ON DELETE SET NULL`: an over-broad
delete would blank an investment's evidence silently instead of failing.

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
holding dozens of numbers. No cut falls inside a number or a date: a cut that
would land in one moves to the token's edge, taking a leading `(` or currency
symbol and a trailing `)` or `CR` with it, and the bound softens by up to 64
characters rather than divide a value. A dot leader is filler, not a number,
so an invoice line still splits. A single token wider than the allowance
leaves its line whole.

**Cited lines need not be adjacent.** A column receipt prints its labels in
one block and its amounts in another, so the only honest citation of a total
is two lines several apart. The value is checked against each cited line on
its own, never against the lines between them, so an unrelated amount in
between can never support a value. A value must sit entirely inside one cited
line; only a text field may span two adjacent cited ones, and only a text
field is matched case- and punctuation-folded. Money, numbers and dates keep
their exact reading.

**One repair, one line, and only where the page leaves no choice (ADM-5h).**
A dense form puts a model one line off its value, so a money or number value
on none of the cited lines may be stored from a line **next to** one of them.
This is the only rule in the round that relaxes a check, so it is fenced on
every side. All ten of these have to hold:

| Condition | Why |
| --- | --- |
| The statement cited line ids | The older quote shape has none, so "one line off" means nothing there |
| The field is money or number | Dates and text are never repaired |
| A money value carries a decimal point or a currency mark | A bare run of digits is a suite number, a tax year or a page number, and each of those stored a wrong total end to end |
| No cited line states a value of that type | Then the model contradicted its own citation rather than missing by a line: `Fee 100.00` cited as a total of 250.00 |
| The target is within one line id of **every** cited line, on the cited page | One off is the miss this exists for; further is a search of the page |
| Exactly one line of that window states the value | Choosing between two is a guess |
| No other line of the **whole document** states it | A value printed twice says nothing about which line states it |
| The target line prints that one value and nothing else | A line with a word on it belongs to that word: `Tax 1.60` beside `Subtotal`, `Invoice 48210` beside `Odometer`, `Page 2023` beside `Tax year` and a K-1's `12 Section 179 deduction` beside `Profit share` each stored the neighbour's number |
| The target's neighbour on the side away from the citation is not itself a bare value | A page that prints its labels together and its amounts together says which amount is which by counting, and counting is the guess this rule refuses: `Subtotal`/`Tax`/`Total` over `20.00`/`1.60`/`21.60` stored a total of 20.00 |
| No other statement of the run was read from that line, and no second statement would repair onto it | One printed number is one field's. A `line_item_list` occupies the lines its entries were read from, like every other accepted reading, and repairs are resolved only after every statement of the reply has been read, so the order the model printed them in cannot change what is stored |

"Prints that one value and nothing else" means exactly one amount is offered
for the line and what is left after removing it -- its sign, its parentheses,
its currency mark or code, a `CR`/`DR` marker, and a percent sign for a
`number` field -- is whitespace and neutral punctuation. A `CR` the scanner
does not read as part of the amount leaves letters behind, so the repair
refuses.

The value stores with the repaired evidence span, so the citation the owner
sees is the line that prints it. Any condition failing leaves the original
`value_not_in_quote` correction, with the citation the model gave.

**A blank optional field is a field the document does not state (ADM-5h).** A
statement whose value is empty, whitespace or null is dropped for an optional
field and opens no item, because that is what leaving the field out would have
meant. A required field still opens one. Anything the box actually prints is a
reading and goes to the gate: `0` and `0.00` are amounts, and `-` and `N/A`
are refused rather than read as zero.

The amount grammar is one explicit rule, written out in
`packages/kith-store/src/extraction/gate.ts` and pinned by a table in
`test/extractionGate.test.mjs` that holds every adversarial input the reviews
have found. A magnitude suffix is **applied**, not dropped and not refused, under two
rules that together keep it from inventing a number.

An **abbreviation** (`k`, `m`, `b`, `mm`, `mn`, `bn`) scales only when it is
pressed against the digits with no space **and** a currency marker sits beside
the same token, on either side: `$2.5M`, `USD 2.5M`, `2.5M USD`, `£1.2k`,
`($2.5M)`. Without a currency marker, digits followed by a magnitude letter
are not an amount at all and the whole token is refused — not read as the bare
number, or `401K` would quietly become 401. This is why: `401K` is a plan,
`1099-K` is a form, `12.99 mm` is a unit and `Room 12 B` is a room, and each
of them read as money before the rule existed. A **word** (`thousand`,
`million`, `billion`) is unambiguous and scales with or without a currency
marker, separated by at most one space.

The scaling is exact, by moving the decimal point. A token carrying a suffix
has exactly one value, the scaled one, on both the value side and the quote
side, so `2.5` can never borrow a citation that says `$2.5M`.

Letters glued to digits are never ignored: they are a currency this grammar
knows (validated against the supported ISO list, not "any three letters"), a
magnitude, or a tax flag — or the token is not an amount. **Known ambiguity:** some banking conventions read a bare `M` as the
Roman thousand and `MM` as the million; this reads `M` as a million, because
the documents are venture and personal finance. If a kind ever needs the
other reading it becomes a setting beside `date_order`.

A tax or status flag is a separate rule: one letter from a small documented
set, exactly two decimal places, and nothing after it. `K`, `M` and `B` are
not in that set, and a lone `C` is refused rather than dropped, because a
credit marker silently removed loses a sign.

**A whole dollar may print its decimal point with no cents after it
(ADM-5h).** A tax form prints every filled box that way, so `5.`, `12,345.`
and `(9,999.)` read as 5, 12345 and -9999. The point is dropped only when it
is the last character of the digits: anything digit-like after it, across any
gap, makes the point a decimal point instead, and a line printing
`12,345.   80` offers neither number because it says 12,345.80 as readily as
it says two cells. For the same reason a rendering space inside a number is
closed up only when it is a single space, **only before exactly two digits**,
and **only when those two digits end the run** -- a gap, the end of the line,
or a mark that cannot belong to a number. Cents are two digits and nothing
else is, so `$82. 129961` and `$94. 504. billion` are the ambiguous pairs
they look like rather than minus 82.129961 and ninety-four and a half
billion; and a letter, a second point or a sign after the two digits says the
run is a box label, a magnitude or a ledger's own sign rather than cents, so
`$6. 25a`, `$5. 25b` and `€642. 73.-` offer nothing. A point pressed against a
whole dollar with a digit reachable through it makes the line ambiguous
whatever stands beyond it, which is how `$780. 554a` offered 780.

**A list ordinal offers nothing (ADM-5h).** Digits at the start of a line,
then `.` or `)`, then a space and a word, are a bullet: `1. Rent 500.00`
offers 500 and not 1. A leading number with no mark after it is a quantity as
often as a bullet -- `12 Mill Lane` -- so the rule stops where its shape
stops, and a box number is still offered. The gate is a whitelist and an
extra candidate costs nothing; a bare run of digits can never repair a
citation onto a money field either way.

Each entry of a `line_item_list` carries its own citation and is gated on its
own: its amount must occur within one cited line, its description folds like
any name and may span two adjacent cited lines, and its evidence span is the
line that prints the amount. An entry's observation key is derived from its own evidence -- the cited line
its amount sits on, a fold of its description, and its position within that
line -- so a correction made on one line does not move onto another when the
model reorders the list between runs, and two identical items on one line stay
apart. A list always keys this way, even with one entry, or the key would
change the week a second line appears.

A key still moves when a re-extraction cites a different but equally valid
line for the same item. The correction is then **not** applied and **not**
inserted under the old key -- that would put the item in the list twice and
make every sum double count -- and one `correction_orphaned` item tells the
owner their fix no longer lands.

An entry that fails is one entry, not the list:
the rest store and a single `line_items_partial` correction says how many are
missing. An amount is the decimal string the line prints, with its decimal
point; a trailing tax or status letter is dropped as a flag; `1299` is one
thousand two hundred and ninety-nine, never twelve ninety-nine. A partial list
is never compared against a stated total.

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
| per-kind page bound | `document_types.examples`, an element `{"setting": "max_pages", "value": "25"}` or `{"setting": "max_pages", "value": 25}` | How many pages of a document of that kind the model is shown, in place of the default 12. Capped at 60; a value past the cap, or one that is not a whole number, reads as unset rather than being clamped. |
| per-kind character bound | `document_types.examples`, an element `{"setting": "max_chars", "value": "120000"}` | The same for characters, in place of the default 60,000. Capped at 400,000. |

A per-kind bound costs the same extra call a per-kind model does, and for the
same reason: the kind is not known until the reply names it, so a first pass
that was cut short is read again with the wider bound. Both passes and the
stored result see the same page list, so a citation to a page the model was
shown always resolves.

A per-kind override costs one extra call the first time a document is read,
because the kind is not known until the reply names it; a re-extraction knows
the kind already and costs one call. Nothing here picks a model.

Two-digit years in a printed date expand 00-69 to the 2000s and 70-99 to the
1900s.

**A date the document only half prints is stored as half a date (ADM-5h).** A
tax letter that states `2024`, and a cover letter that states `March 2024`,
used to lose their date entirely to `date_unparsable`. Both now store, with
the precision they were printed at: a year keeps `YYYY`, a month keeps
`YYYY-MM`, and `precision` on the stored value says which. **Nothing is
padded.** A full day keeps exactly the shape every stored date has had, with
no `precision` key, so no existing reader changes. A partial date dates no
event: `occurrence_date` holds a calendar day, so a document whose only date
is a year stays undated rather than being filed under the first of January.

A partial date is checked against its cited line for exactly the parts it
claims. A year has to be printed **as a year**: between 1900 and 2100, with a
digit run of its own, and with nothing glued to its left but a `FY`, `CY` or
`TY` prefix -- so `98101-2024`, `(206) 555-2024`, `x2024`, `1099-2024` and a
copyright sign are not years. One space to its left, a currency mark or an
ISO code makes it money (`$ 2024`, `USD 2024`) and a label such as `Rev.` or
`Form` makes it a revision or a form number; a street word to its right makes
it a house number (`2024 Main Street`). A whole date printed on the line
states its year too, which is the one way a year reads through a slash.

A month and a year have to be printed together, adjacent, and the pair has to
**open the line or follow a word that introduces a date**, or `Ratio 3/2024`,
`Pages 3-2024` and `You may 2024` would each file a document under a month
nobody wrote. A numeric month and year are read through the kind's
`date_order` like any other date. A two-digit year is refused for a
partial date, because `March 24` is March 2024 and the twenty-fourth of March
at once and there is no third part to settle it, and two numbers with no year
among them (`03/04`) are refused for the same reason.

**A re-extraction never downgrades an exact date (ADM-5h).** Extraction
replaces a document's observations on every run, and a model reads the same
page differently from one run to the next. When a run offers only a year or
only a month and a year for a field that already holds a full day, and the
stored day begins with what the new run read, the stored day and **its own
evidence** are kept, and it goes on dating the event. A partial date that
contradicts the stored one -- a different year, or a different month --
replaces it, because then the two runs disagree about the document and
keeping the old day would store a date this run does not support. The kept
day never borrows the new run's citation: the line the new run cited prints a
year, and hanging a day off it would be the fabricated citation the gate
exists to prevent.

An all-numeric date whose first two numbers could both be a month is read only
when the kind sets `date_order`. `01/02/26` is the first of February or the
second of January and the string cannot say which, so unset it opens a
`date_ambiguous` correction rather than storing a coin flip. A date that
settles itself needs no setting: `13/02/2026` has no thirteenth month,
`9 Apr 26` names it, and an ISO date is an ISO date. The owner's documents are
overwhelmingly US, so `MDY` is the likely setting, but it is the owner's to
make per kind.

A space inside a number is closed up only next to a currency symbol or an ISO
code, and only one space, so `$ 165 .00` reads as one amount while
`APPLES 12 .99` stays a quantity beside a price. A column-rendered amount with
no currency mark beside it opens a correction instead, which is the cheaper of
the two errors.
