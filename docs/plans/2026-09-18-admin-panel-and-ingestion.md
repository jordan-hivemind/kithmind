# Admin panel, sources and typed extraction

Date: 2026-09-18
Status: adopted direction. The owner decided the items in section 1. Everything
else is the orchestrator's recommendation and may change as screens are built.

## 1. Owner decisions

| Topic             | Decision                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quality bar       | A personal project, built well. Not enterprise software. The source files are the ultimate backup. No new hardening unless it blocks use.                                                                           |
| Priority          | Ingest real life data across many types, to test flexibility and precision. Outside investments first, then bank and card statements, other brokerages, medical records, vehicle service records, project receipts. |
| Operation         | Long term the product is operated from its own UI, not from a coding agent. Adding a major new provider through a coding agent is fine, but the UI must show a complete inventory so gaps are visible.              |
| Configuration     | Out of JSON files and into the database: document types and fields, watched sources, mappings.                                                                                                                      |
| Watcher host      | The always-on home machine is the long-term home of the filesystem watcher. The laptop is the interim host.                                                                                                         |
| Moves and renames | Watched folders and files must self-repair when renamed or moved. No breakage, no duplicates.                                                                                                                       |
| Investments       | Tracked in the app, not in a spreadsheet. The existing spreadsheet is imported once. Entry forms for capital calls, distributions and the like are the frequent path.                                               |
| UI behaviour      | Reactive. Edits apply optimistically with no refresh. Server-side changes appear live with no refresh.                                                                                                              |
| UI style          | White, gray and blue. Inter. Compact tables. Kebab menus for row actions. Everything sortable and filterable with search as you type. Tooltips for detail. Square tags. No explanatory prose in the UI.             |
| Reviews           | Second-model review only for sign-in, access control, MCP exposure and anything that changes financial numbers.                                                                                                     |
| Runtime pins      | Keep a recorded parser version so reprocessing is reproducible. Drop per-file hash manifests and config fingerprint ceremony. Updates are pull, build, restart.                                                     |

## 2. What exists and what does not

| Area             | Today                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Documents        | Parsed to pages, chunks and cited evidence spans, embedded, searchable through MCP. PDF and xlsx only.                        |
| Typed extraction | Not running. The read side (events, observations, `query_records`) exists. Nothing writes to it since the move to PostgreSQL. |
| Watched sources  | One private JSON config per source on the watcher host. The web app can only name and enable a source.                        |
| Document types   | TypeScript constants. Not visible or editable.                                                                                |
| Finance archive  | One institution, strict typed records, its own read contract. Unchanged by this plan.                                         |
| Web app          | Next.js 15, React 19. Pages: browse, settings, spaces, getting started. No admin panel. No live updates.                      |

## 3. Stack

| Piece        | Choice                                                                             | Why                                                                                   |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| App          | The existing Next.js app                                                           | Sign-in, spaces and the store are already wired.                                      |
| Styling      | Tailwind plus a small set of accessible primitives (menu, tooltip, dialog, drawer) | Matches the style decision with little code.                                          |
| Tables       | TanStack Table                                                                     | Sorting, filtering, search, grouping and expandable rows from one headless component. |
| Client state | TanStack Query                                                                     | Optimistic mutations with rollback, and targeted refetch.                             |
| Live updates | A change feed (section 4)                                                          | PostgreSQL and serverless hosting give no subscriptions on their own.                 |

## 4. Change feed

1. A `kith.changes` table: monotonically increasing id, space id, table name, row id, operation, committed at.
2. Triggers on the tables the UI shows write one row per insert, update and delete. Rows older than a few days are pruned by the deferred-work daemon.
3. `GET /api/kith/changes?since=<id>` streams server-sent events for the caller's authorized spaces. It falls back to a short poll with the same cursor when the stream drops.
4. A client hook maps each change to the query keys it invalidates.

Access control: the route uses the same session and space authorization as every other route, and returns ids and table names only, never row content. This route gets a second-model review.

## 5. Data model additions

| Table                  | Holds                                                                                                                   | Notes                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `document_types`       | kind, description, area, extraction guidance, examples, version, active                                                 | Editing creates a new version. Extracted documents record the version they used.                                   |
| `document_type_fields` | type id, field name, value type, required, check (on page, exact, sums to total), example                               | Value types: text, organization, person, date, money, number, identifier, line item list.                          |
| `source_roots`         | source account id, kind (folder, institution, manual), provider folder id, last known path, expected types, area, state | The desired list. The watcher pulls it each pass.                                                                  |
| `source_root_reports`  | what the watcher host sees: available top-level folders, counts, skipped files with reasons, last pass, problems        | Written by the watcher, read by the UI.                                                                            |
| `investments`          | entity id, category, signed date, status, notes                                                                         | One row per investment.                                                                                            |
| `investment_entries`   | investment id, entry type, date, amount, currency, exchange rate, note, document id, evidence span                      | Capital call paid, distribution, commitment, commitment change, fee, write-off. Totals are computed, never stored. |
| `corrections`          | target (document, field or record), original value, corrected value, actor, reason, time                                | The original reading is kept. Reads prefer the correction.                                                         |
| `changes`              | section 4                                                                                                               |                                                                                                                    |

Statements produced by extraction are ordinary observations with evidence spans, so `query_records`, coverage and citations keep working.

## 6. Sources that repair themselves

| Case                                          | Behaviour                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watched folder renamed or moved               | The source is keyed by the provider's folder id. The watcher resolves the id to the current path each pass and updates `last known path`. Nothing is re-ingested. |
| File renamed or moved inside a source         | Keyed by provider file id. Same document, new location recorded.                                                                                                  |
| File copied to a second place                 | Same content hash, different file id: recorded as a duplicate of the first, not a second document.                                                                |
| File moved out of every source                | Marked unavailable, then retired after a grace period. The archived original is kept.                                                                             |
| Provider id unavailable (non-provider folder) | Fall back to content hash plus size. A rename looks like a removal and an addition with the same hash, and is joined.                                             |
| Folder deleted                                | The source shows a problem in the UI. Nothing is deleted.                                                                                                         |

The watcher host keeps one local setting: the top-level directories it may read (for example the synced provider folder). A database row can never point it outside them.

## 7. Watcher host

| Step    | Detail                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interim | The laptop keeps running the watcher.                                                                                                                                                                              |
| Move    | Install the provider's sync client and the worker checkout on the always-on machine, create a worker credential for it, copy the journal and archive catalog once, start the LaunchAgent there, stop the laptop's. |
| After   | The laptop is a client only. The health page shows which host is watching and when it last passed.                                                                                                                 |

## 8. Extraction

One pass per document over the sealed text produces typed statements: party, date, money, identifier, line item, term. Each carries its evidence span and a confidence, plus a kind label and a one-line summary. Classification follows the document's operative effect rather than its title or folder. An investment agreement creates or acquires an investment commitment, security or economic ownership interest. That includes an LLC membership agreement that conveys equity, units or capital and profit rights. It excludes a service or association membership whose dues buy access or benefits but no security or ownership interest. Checks are per value type, not per kind: a value must appear in the cited text, money and dates must parse exactly, line items must sum to a stated total where both exist. A failed check opens a correction item instead of storing a guess. Kinds are rows in `document_types`. Adding a kind is a row, not a release. Editing guidance bumps the version and re-extraction is on demand. Image receipts are normalized to PDF before intake and go through OCR. Strict typed records remain for ledgers and statements, fed by deterministic parsers or by extraction with arithmetic checks.

Starter guidance changes do not overwrite existing spaces during ordinary extraction. The operator runs `kith-extraction-classification-upgrade` without flags to inspect eligibility, then repeats it with `--apply` to clone exact shipped guidance into a new version. The command preserves the current fields, model settings, bounds, area and sensitivity. It skips owner-edited classifier text. Re-extraction remains a separate, explicit operation after the version update.

A resolved correction remains in history across reclassification. Re-extraction materializes it into exact records only when its field belongs to the document's current kind. Restoring a compatible kind makes the correction current again. This prevents a corrected investment amount from surviving as an active record after the owner classifies the document as a non-investment kind.

This classifier update does not change date semantics, required-field omission handling or extraction-model escalation. Agreement or effective dates must remain distinct from actual signature timestamps, omitted required fields still need an explicit gate, and failed quality gates still need a defined escalation path. Those changes remain coordinated extraction work rather than part of the membership-classification repair.

The `sums_to_total` check spans two fields, so it needs one naming convention. A document type whose field carries that check states the sum in a money field named `subtotal`, or in one named `total` when the type has no subtotal. The preference matters on a taxed receipt: the items sum to the subtotal and the total carries the tax. A type that names its sum anything else gets no sum check, which is the same as declaring none.

Dropped from the earlier card design: closed kind enums, the model tier ladder, weekly budgets and the pausing queue, the rule that a source publishes nothing until a subject entity exists, and the entity binding gate. Names are stored as written and bound to entities later.

## 9. Screens

| Order | Screen           | Shows                                                                                                                                                                           |
| ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Health           | Checks with plain status. Same content as the daily report.                                                                                                                     |
| 2     | Sources          | Every folder, institution and manual source: location, area, items, skipped, last read, status. Add folder.                                                                     |
| 3     | Institutions     | Institutions as expandable groups over their accounts: statements, activity range, latest snapshot, open reviews, status.                                                       |
| 4     | Coverage         | Life areas against sources, documents, records, date range and gaps.                                                                                                            |
| 5     | Investments      | Investments with computed committed, sent, outstanding and received, expandable into entries. Add entry is the primary action. Import from a spreadsheet is a secondary action. |
| 6     | Types and fields | Kinds, their fields, checks, guidance, versions. Edit and re-extract.                                                                                                           |
| 7     | Corrections      | Open and resolved items with the original reading and the fix.                                                                                                                  |

## 10. Build order

| Step | Delivers                                                                                            | Usable result                                             |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1    | Schema for section 5, change feed, UI foundation (Tailwind, table, query cache, live hook)          | Nothing visible yet.                                      |
| 2    | Health, Sources, Institutions, Coverage, read-only and live                                         | An inventory of everything the system reads, with gaps.   |
| 3    | Investments: tables, entry forms with optimistic saves, one-time spreadsheet import, MCP read tools | Exact answers about commitments, calls and distributions. |
| 4    | Sources write path: add folder, provider ids, self-repair, watcher pulls `source_roots`             | New folders added from the UI.                            |
| 5    | Extraction writer, types and fields screen, corrections                                             | Typed, cited answers from documents and receipts.         |
| 6    | Watcher moves to the always-on host                                                                 | Ingestion independent of the laptop.                      |

## 11. Acceptance for the first use case

Through the MCP connector the owner can ask, and get exact, cited answers to: committed versus sent versus outstanding per investment, which investments returned capital, exposure by category, what was signed with a given company and its key terms, and the tax forms for a given year.

## 12. Linking investment documents (ADM-3)

The owner does not file documents by hand: he enters the investment dollars
and drops the supporting files in the watched Investing folder. Step 3 built
the entry side of that and the suggestion side of it. Step 5's extraction
writer supplies the rest, and this section fixes the rule so that step does not
have to re-decide it.

### What exists now

| Piece                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investment_entries.document_id` | Optional. One entry cites at most one document.                                                                                                                                                                                                                                                                                                                              |
| `suggestDocumentsForEntry`       | Computed on read, never stored. Ranks the space's published, unlinked documents by three signals: the investment's name in the document title (3), an exact string form of the entry amount in its text chunks, tried as `25000.00`, `25,000.00`, `25000` and `25,000` (2), and a capture date within 45 days of the entry date (1). A document scoring zero is not offered. |
| Unlinked count                   | Per investment: published documents whose title contains the investment's name and that no entry links to. The screen shows it as a gap, not a total.                                                                                                                                                                                                                        |
| Upload                           | Present and disabled, with the tooltip "Drop files in the watched Investing folder".                                                                                                                                                                                                                                                                                         |

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

| Total       | Rule                                                  |
| ----------- | ----------------------------------------------------- |
| committed   | `commitment` plus `commitment_change`                 |
| sent        | `capital_call_paid`, and only that                    |
| fees        | `fee`, its own total, never folded into sent          |
| received    | `distribution`                                        |
| outstanding | committed minus sent, **signed**                      |
| overCalled  | sent minus committed when that is positive, else zero |

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

| Row                                   | How the seal knows it is extraction's                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Event version, observation            | `event_type = 'document_statement'`                                                                               |
| Evidence span, written from ADM-5i on | `locator->>'kind' = 'extraction_v1'`                                                                              |
| Evidence span, written before that    | Referenced only by a `document_statement` observation's `value_evidence` or that event version's `field_evidence` |

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

| Table                                     | Column                        |
| ----------------------------------------- | ----------------------------- |
| `processing_generation_payload_manifests` | `evidence_span_ids`           |
| `observations`                            | `value_evidence`              |
| `event_versions`                          | `field_evidence`              |
| `documents`                               | `evidence_span_ids`           |
| `chunks`                                  | `evidence_span_ids`           |
| `worker_parsed_stages`                    | `evidence_span_ids`           |
| `investment_entries`                      | `evidence_span_id`            |
| `document_extractions`                    | `statements[].evidenceSpanId` |

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
every side. All eleven of these have to hold:

| Condition                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The statement cited line ids                                                                        | The older quote shape has none, so "one line off" means nothing there                                                                                                                                                                                                                                                                                                                                                                                                 |
| The field is money or number                                                                        | Dates and text are never repaired                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A money value carries a decimal point or a currency mark                                            | A bare run of digits is a suite number, a tax year or a page number, and each of those stored a wrong total end to end                                                                                                                                                                                                                                                                                                                                                |
| No cited line states a value of that type                                                           | Then the model contradicted its own citation rather than missing by a line: `Fee 100.00` cited as a total of 250.00                                                                                                                                                                                                                                                                                                                                                   |
| The target is within one line id of **every** cited line, on the cited page                         | One off is the miss this exists for; further is a search of the page                                                                                                                                                                                                                                                                                                                                                                                                  |
| The target is the line **after** a cited line, never the one before it (ADM-5k)                     | A label stands above its amount. Reaching backwards as well, the repair could not tell which side of a label it was reading: `Subtotal`/`20.00`/`Total`/`21.60` with a total of 20.00 cited to `Total` stored the subtotal's amount as the total, because 20.00 is one line from `Total` exactly as 21.60 is. The backwards miss -- a citation naming the line _after_ its value -- is refused with it: it is the rarer half of a rule that could not tell them apart |
| Exactly one line of that window states the value                                                    | Choosing between two is a guess                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| No other line of the **whole document** states it                                                   | A value printed twice says nothing about which line states it                                                                                                                                                                                                                                                                                                                                                                                                         |
| The target line prints that one value and nothing else                                              | A line with a word on it belongs to that word: `Tax 1.60` beside `Subtotal`, `Invoice 48210` beside `Odometer`, `Page 2023` beside `Tax year` and a K-1's `12 Section 179 deduction` beside `Profit share` each stored the neighbour's number                                                                                                                                                                                                                         |
| The target's neighbour on the side away from the citation is not itself a bare value                | A page that prints its labels together and its amounts together says which amount is which by counting, and counting is the guess this rule refuses: `Subtotal`/`Tax`/`Total` over `20.00`/`1.60`/`21.60` stored a total of 20.00                                                                                                                                                                                                                                     |
| No other statement of the run was read from that line, and no second statement would repair onto it | One printed number is one field's. A `line_item_list` occupies the lines its entries were read from, like every other accepted reading, and repairs are resolved only after every statement of the reply has been read, so the order the model printed them in cannot change what is stored                                                                                                                                                                           |

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
have found, and by a seeded generator in `test/extractionAmountFuzz.test.mjs`
whose oracle is an independent `BigInt` calculation from the pieces it
printed. The generator prints the shapes the reviews had to find by hand:
spaced magnitude letters, unit words, scale words it declares unpriceable,
unbalanced parentheses, a credit marker in front of an amount, double signs,
digits from other scripts inside a number, `$N. N`, a decimal head beside
space groups, pipe-rendered rows and two-line wraps. `KITH_AMOUNT_FUZZ_CASES`
and `KITH_AMOUNT_FUZZ_SEEDS` run it harder than the suite does.

**The generator asserts recall as well as refusal.** A gate that offers
nothing at all can never offer a wrong number, so the four wrong-number
invariants would pass a grammar that is useless -- and the first round of
ADM-5k lost about a third of the correct offers on pipe rows without a single
invariant noticing. Five families of plain shape are generated with the
opposite claim: every amount printed on them must come back with its exact
value. They are pipe-rendered rows of two to six amount cells, columns of
amounts across lines, a form's lettered rows, a place or company name beside a
figure, and a plainly labelled amount. Each is built from amounts this grammar
is documented to read -- no magnitude, no flag, no damage, and no euro comma
group, whose locale ambiguity is documented behaviour rather than a shape the
grammar is meant to read. `KITH_AMOUNT_FUZZ_RECALL=1` prints the measured rate
per family. A magnitude suffix is **applied**, not dropped and not refused, under two
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

**The scale and unit vocabulary is a rule, not a deny-list (ADM-5k).** Before
this, any word the grammar did not recognise was neutral, so `$2.5 trillion`,
`₹2.5 lakh`, `$2.5 mln` and `$3 thou` each offered the unscaled number and
`45 cents` and `45.00 percent` each offered forty-five. Every word a document
prints beside an amount now falls in one of three tables.

| Table                           | Words                                                                                                                                                                               | What happens                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scale, read                     | `thousand(s)`, `million(s)`, `billion(s)`, `trillion(s)`, `lakh(s)`, `crore(s)`, and the abbreviations `k`, `m`, `b`, `mm`, `mn`, `bn` glued to the digits beside a currency marker | The point moves. Each of these spells one number and no other                                                                                                                                                                                        |
| Scale, refused outright         | `mil`, `mio`, `mln`, `thous`, `trn`, `tril(l)`, `lac(s)`, and a magnitude abbreviation a space away from its digits                                                                 | The word joins the token and the whole token is refused. None of these is an English word or a name                                                                                                                                                  |
| Scale, refused after the amount | `mill(s)`, `thou`, `grand`, `bil`, `bill(s)`, `tn`                                                                                                                                  | The same, but only directly after the amount and only where the word does not open a name. `mill` is a million and a property-tax mill; `bill` is a billion and an invoice; `grand` is a thousand and an adjective; `tn` is a trillion and Tennessee |
| Unit                            | `cent(s)`, `percent`, `percentage`, `pct`, `bp`, `bps`, `basis`                                                                                                                     | Refused for a money field. A unit is not a scale: `45 cents` is not forty-five dollars and `45.00 percent` is not forty-five of anything a money field stores                                                                                        |
| Counted unit                    | `share(s)`, `unit(s)`                                                                                                                                                               | Refused for a money field **only where the amount prints no currency mark**. `100 shares` is a holding; `$50,000.00 Shares issued` is fifty thousand dollars, and the mark says so                                                                   |

A **unit** word counts only where a unit can stand, which is directly after
the amount: `Cost basis 1,234.56` is a money line with a label on it, and
`1,234.56 basis points` is not a money value at all. `per`, `each` and
`apiece` are not units here at all: a rate is still the printed dollars, and
the gate's claim is that the cited text prints the value rather than that the
value is a total. The `number` value type is dimensionless by construction and
keeps its existing reading of units, exactly as it already keeps `12 %`.

**A Capitalized word followed by another Capitalized word is a name**, and a
name is never a scale. That one test, applied wherever a scale word stands
beside an amount, is what lets `$1,250.00 Mill Creek Partners LP`,
`500.00 Grand Rapids` and `12 Mill Lane` read while `$2.5 mill` and
`$2.5 Mill` refuse -- and it closes the mirror hole in the same move:
`45.00 Thousand Oaks` offered forty-five thousand and `45.00 Lakh Street` four
and a half million, because a _read_ magnitude was scaling a place name. The
finder has no gazetteer, and every other way of telling a town from a
multiplier is a guess.

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

ADM-5k added the last two conditions on that rule. **A gap and a lowercase
word after the two digits is prose**, not a receipt cell: `We paid $500. 25
people` is a sentence with a full stop in it, and the rule closed the gap and
offered 500.25. A sentence and a cell print the same characters, so both
readings are refused and `$82. 12 due` and `$94. 50 total` lose their amounts
with it. And **the marker has to be a currency this store prices**: three
capitals are a word far more often than a code everywhere else in this file,
and the gap-closing rule was reading any of them, so `FEE 162. 95` and
`QTY 12. 34` closed up into amounts. The second round added the third: **a gap
and a digit after the two digits is the next cell**, so `$7. 42 849.70` no
longer offers 7.42 and 849.70 for a line that prints either two cells or one
number and does not say which.

**Neutral punctuation is not a wall (ADM-5k).** A bar, a semicolon or a
quote mark cannot sign or scale a number, and the finder therefore stopped at
one and offered the amount -- so the marker behind it was invisible.
`| Payment | 45.00 | CR |` printed a credit and offered a charge, `$45.00 |
million` offered forty-five and `-| 45.00` offered a positive. The finder now
steps over neutral punctuation to the real neighbour beyond it, bounded like
every other walk in the file.

**And what stands past a rule is a cell, asked as a cell.** Stepping over the
bar and stopping at the first character refused a third of the correct offers
on pipe-rendered tables, which is how several of this store's parsed receipts
print a column: a cell opening with `$`, `(`, `-`, a currency code or a
label's closing parenthesis looked exactly like a marker. A cell says nothing
about the amount on the other side of the rule when it is any of three
things, each decided mechanically:

| Harmless cell                                                                                                | Example                                                   |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| One printed amount and nothing else, sign and marker included                                                | `$150.00`, `(6.00)`, `-1,204.17`, `3,200`, `£9,898.64 CR` |
| A lone currency code, or a blank marker                                                                      | `USD`, `N/A`, `none`                                      |
| A label: no digit, balanced parentheses, nothing that signs or scales, every word neutral on its own account | `Net income (loss)`, `Check`, `Dividends`                 |

Everything else falls through to the ordinary neighbour rule, so a `CR`, `DR`,
`%`, magnitude or unit cell refuses exactly as it did.

**An unreadable neighbour is unknown, not separate (ADM-5k).** A digit this
grammar must not read poisons its token, and the poison mark cut the token in
half -- so the neighbour rule was handed a fragment, found that the fragment
joined nothing, and offered the amount beside it. `380 3१24.5` offered 380.
The poison mark on either side of a neighbouring run now refuses the amount,
which is the answer a cut edge already gets. The set of poisoned digits is a
Unicode property rather than a list of blocks: anything Unicode files as
"other number" -- `①`, `⒈`, `❶`, `½` -- because a list is what the
last four reviews kept finding a gap in.

**Two runs join when _any_ reading joins them (ADM-5k).** "Do these two runs
join" is a question about digits and separators, and a reading refused for
some other reason is no evidence they are separate. `1, 234K` offered the
leading 1 because `1,234K` is refused for want of a currency marker -- a rule
about `401K`, not a proof that the 1 stands alone. The pasted region is now
asked four ways: as it stands, without a currency marker it opens with, with
a marker it does not print, and without a trailing tail that belongs to
neither run.

**A compound amount is one number (ADM-5k).** `$3 million 2 thousand`,
`1 crore 25 lakh` and `5 lakh 20 thousand` are each one figure said the way a
person says it out loud, and the finder offered the first half whole -- short
by whatever the second half adds. Two scaled spans a **single space** apart,
the larger scale first, are refused together. One space, because a wider gap
is a column and a column of scaled cells is two amounts: `| $2.5M | $3.0K |`
still reads both.

**A decimal head never takes space groups (ADM-5k).** A single space before a
run of exactly three digits is a grouping separator in `$1 000 000` and a
column boundary in `$123 456   789`; only the last character of the head was
checked, so `$12.99 100 200` offered 12.991002 -- a number with the cents of
one cell and the digits of two more. The head has to be a bare run of digits.

**A line break is not a full stop (ADM-5k).** A real line edge was a _known_
edge, so nothing asked what stood past it: a letter printing `raised $2.5`
with `million` wrapped onto the next line offered two and a half, and a ledger
printing `CR` above its amount offered a charge. Each line now carries the
last token of the line before it and the first token of the line after it, and
an amount touching that edge is refused when the token is scale- or
sign-bearing -- a magnitude word or letter, `CR`/`DR`, a currency code, a
sign, a bracket, a percent sign. The token is never read as part of the
amount: assembling a number out of two lines is the fabrication this gate
exists to prevent.

Scale and sign, and deliberately nothing else. A column receipt prints one
amount per line and a form labels its boxes, so a digit or an ordinary word on
the next line is the common case and refusing those would cost every receipt
and every K-1 in the store. A cut edge carries no wrap token, because a cut is not
a line break and what lay beyond it is still gone.

Three more rules on the same edge, all of them from the first confirmation
review, which measured the first round refusing an eighth of the correct
offers on amount columns:

- **An amount the neighbouring line prints for itself is a value, not a
  marker.** The question is asked of the _edge_: that line's own reading has
  to run up to the break. `$20.00` over `$1.60` over `$21.60` is a column and
  every line of it reads; `($ 9,696,944)` over `197,577.62` is two amounts;
  `45.00 CR` over the next row is a credit of its own, because the `CR` has a
  number in front of it on its own line. An amount in the _middle_ of the
  neighbouring line settles nothing, which is what keeps `raised $2.5` over
  `million from` refusing.
- **A single closing letter is a row label when a word follows it.** A K-1
  prints `K Net rental real estate income` and `M Section 179 deduction`, and
  a W-2 prints code `D`; refusing the box above each of them cost the form.
  A closing letter refuses only where it stands alone, ends its line, or is
  followed by punctuation or a digit.
- **What a reader cannot see is not a token.** Zero-width characters and soft
  hyphens are stripped before the lead is cut, a blank line is looked past
  rather than stopped at, and punctuation in front of the word is stepped over
  the way it is within a line. A next line beginning `*CR`, `[CR]`, `.million`
  or `, million`, or sitting behind a blank line, hid its marker and offered
  the unsigned or unscaled value.

**Known behaviour, documented rather than fixed.** A grouping separator at a
line end with digits on the next line could be one wrapped number:
`Total $1,234,` over `567` offers 1,234. Refusing every line-final separator
with a digit under it would refuse every K-1 box, whose trailing point sits
above the next box's number, and a PDF's text layer does not break a number in
half. The locale ambiguity is the other one: `3.499`, `Rp 12.000` and
`12.345 kr` read as a decimal point wherever the token carries no currency
whose own locale says otherwise. Both need a per-kind setting beside
`date_order` and neither has one.

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

| Knob                     | Where                                                                                                                      | Effect                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KITH_EXTRACT_MODEL`     | daemon environment                                                                                                         | The default model. Unchanged.                                                                                                                                                                              |
| `KITH_EXTRACT_ENDPOINT`  | daemon environment                                                                                                         | OpenAI-compatible chat completions. A 4xx on the JSON-schema request falls back to plain JSON for the rest of the run.                                                                                     |
| `KITH_EXTRACT_API_KEY`   | daemon environment                                                                                                         | Falls back to `OPENAI_API_KEY` on the default endpoint.                                                                                                                                                    |
| per-kind model           | `document_types.examples`, an element `{"setting": "extraction_model", "value": "<model>"}`                                | That kind is read with that model. A kind without one uses the default. A model the provider refuses falls back to the default for that run and opens one `extraction_model_refused` item.                 |
| per-kind date order      | `document_types.examples`, an element `{"setting": "date_order", "value": "MDY"}` or `"DMY"`                               | How that kind writes an all-numeric date.                                                                                                                                                                  |
| per-kind page bound      | `document_types.examples`, an element `{"setting": "max_pages", "value": "25"}` or `{"setting": "max_pages", "value": 25}` | How many pages of a document of that kind the model is shown, in place of the default 12. Capped at 60; a value past the cap, or one that is not a whole number, reads as unset rather than being clamped. |
| per-kind character bound | `document_types.examples`, an element `{"setting": "max_chars", "value": "120000"}`                                        | The same for characters, in place of the default 60,000. Capped at 400,000.                                                                                                                                |

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

## 14. Institutions freshness (FIN-FRESHNESS-1)

One 45-day threshold on the latest holdings date marked three kinds of
account stale for the wrong reason: a quiet account that files quarterly, an
all-cash account with nothing to snapshot, and an account whose statements
kept arriving while the holdings in them stopped being recorded. Only the
third is a real gap. The rule is now `accountFreshness` in
`apps/web/src/lib/kith/account-freshness.ts`.

The archive's `list_account_inventory` adds two fields, both facts about rows
that exist: `balanceDates`, the account's latest distinct balance dates, newest
first and at most 12; and `latestBalanceHoldsSecurities`, whether the latest
balance that states both a total and cash holds anything besides cash. An
expected date is never stored or returned as data. `latestSnapshotAsOf` and
`currentValue.asOf` keep their meanings and are never merged with a balance
date.

**Cadence** comes from the balance dates. Consecutive months are `monthly`.
`quarterly` requires at least four observed statement months that establish
three repeated long intervals. Gaps are at most three months and every long
gap ends on a quarter end (monthly while active, quarterly while quiet). Two
isolated quarter ends or one missed monthly import do not earn the longer
allowance. Anything else is `unknown`, which is held to the monthly allowance
and says so in the tooltip.

A statement is **due** by the first period end after the latest balance plus
20 days of grace. An account is **dormant** after 100 days without activity
(204 for quarterly). Only the owner's Closed flag closes an account. A balance's
size never does.

| Synthetic account on 2026-09-18                          | Status   | Reason                               |
| -------------------------------------------------------- | -------- | ------------------------------------ |
| Balances monthly to 2026-08-31, holdings 2026-08-31      | fresh    | current                              |
| Balances quarterly to 2026-06-30, holdings 2026-06-30    | fresh    | current, next expected by 2026-10-20 |
| Balances monthly to 2026-06-30, last activity 2026-06-30 | stale    | statement overdue                    |
| Balances monthly to 2026-08-31, holdings 2025-09-30      | stale    | holdings behind                      |
| Latest balance holds securities, no holdings ever        | stale    | holdings missing                     |
| Latest balance all cash, last holdings 2025-04-30        | fresh    | balance only                         |
| Bank or credit line type                                 | fresh    | balance only                         |
| Transactions only, no balance or holdings                | fresh    | no balance                           |
| No activity since 2022-12-31                             | inactive | dormant                              |

**Parents** are honest aggregates. A group is stale when any live account is,
and its tooltip counts stale accounts by reason, because an overdue statement
and a holdings gap call for different actions. A group total is stale when any
part of it is stale by that account's own cadence, and stays dated by its
oldest part.

The inventory's current value also treats two balance rows on the latest date
that state the same total and currency as one answer, not an ambiguity. Rows
that differ still report nothing.

Known limits, left for later work: balance dates cannot distinguish a source
that failed to ingest several statements from an account whose real reporting
schedule changed. Insufficient or conflicting evidence remains `unknown` and
uses the stricter monthly allowance. Holdings that the statement parser
refuses (a security printed as several lots with no Total row) show as
`holdings behind`. They are not suppressed, and the fix belongs in the parser,
followed by an auditable reimport.
