# Financial archive: holdings and transactions

**Status:** Planned workstream inside this repository. It does not block the
single-owner document-Q&A trial and does not depend on it.

## Goal

Build a durable, local, queryable archive of one person's financial accounts
across every institution they use, so that an assistant with no browser access
and no logins can answer questions about the money and cite where each number
came from.

Today this data is reachable only by signing into each institution's site. Every
analysis restarts from nothing and nothing accumulates. Success is not that
files were downloaded. Success is that a single query answers what was paid in
fees last year across all institutions, what the current holdings and cost bases
are, what is owed, and which document supports each figure.

## Relationship to Kith Mind

This archive is a source, not a second brain. The relationship has three parts
and they are fixed:

1. **The archive owns canonical financial identity.** Transaction and position
   identity, deduplication, and reconciliation happen here. Kith Mind does not
   build a competing authoritative financial record set from the same statements.
2. **The plugin point for reuse is the institution adapter.** Acquisition and
   parsing for one institution is a self-contained module against a published
   interface. Someone else can use the adapters shipped here or write their own
   without touching the store, the schema, or the query layer.
3. **Kith Mind consumes the archive through a versioned read interface.** It may
   link to archive records or maintain a deliberate read projection. The same
   institution adapters feed both, so there is never a second ingestion path for
   the same statements.

The `financial_transaction` event type, exact money values and `query_records`
in the [record-query contract](./2026-09-06-record-query-contract.md) remain the
Kith Mind side of that boundary. The P2-10 financial playbooks reuse archive
records where adopted rather than re-extracting the same documents.

## Decisions

| Question                 | Decision                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage engine           | SQLite. Single file, no server, exact integer or decimal-string money, full SQL for ad hoc questions, trivial to copy and hash for backup.                                                                                                                                  |
| Existing ledger software | Not adopted. Beancount, hledger, GnuCash and similar are double-entry spending ledgers. They have no first-class model for lot-level cost basis, per-field provenance, or reconciliation status as a gate. Reuse of their importers is not worth adopting their data model. |
| Scope                    | Holdings as well as transactions. Positions, balances and liabilities are v1, not v2. Half the value of the archive is what is owned and what is owed.                                                                                                                      |
| Access surface for v1    | A local read-only MCP server over the archive. Not a five-operation typed contract, and not the Kith Mind adapter.                                                                                                                                                          |
| Query shape              | Read-only SQL plus a documented schema, exposed through the local server. Frequently used shapes are promoted into typed operations later, once real questions have shown which ones matter.                                                                                |
| Where the code lives     | This repository, MIT, with synthetic fixtures.                                                                                                                                                                                                                              |
| Where the data lives     | Outside this repository, in a configured local directory for now. Never in git. Local first because it is the simpler starting point, not a judgment about hosting: running the archive as a cloud service later is explicitly open, and the schema and money policy are engine-portable so that move is a migration rather than a redesign.                                                                                                                                                |
| Standing CSV exports     | Not produced. A table mirror beside a live database is a second source of truth. Backup is a file copy plus a hash. Export is an on-demand script.                                                                                                                          |

The typed-bounded-query rule in the record contract exists to protect
multi-user spaces and untrusted clients. This archive is single-user,
read-only, local, and holds no credentials, so that rule does not apply to its
own read surface. It does apply at the Kith Mind boundary, and the archive must
be able to satisfy it there without redesign.

## Ground rules

1. **Raw files are immutable.** Everything acquired is written once to the raw
   tree, never edited, never deleted. All structured data is derived and can be
   rebuilt from scratch. A parsing bug must never require re-acquisition.
2. **Every derived row carries provenance:** source document, page or row
   locator, and a content hash.
3. **Reconciliation is a gate, not a report.** An import that cannot tie
   transactions to stated balances fails loudly and marks the affected periods
   unverified. A discrepancy is never silently absorbed.
4. **Authentication is never automated.** No stored credentials, no scripted
   logins, no MFA handling. A person signs in; the adapter captures what is on
   the other side. Recurring updates process a drop folder, they do not sign in.
5. **Ambiguous money is null with a note,** never inferred. Financial data that
   is confidently wrong is worse than data that is missing.
6. **Text extraction before OCR.** These are generated PDFs with a text layer.
   OCR is a fallback for a document that genuinely has none, and any such
   document is flagged in the import log.
7. **Never assert absence from a paginated listing.** An absence claim requires
   an exhaustive source: a server-reported total that the pull reconciles
   against, or a listing paginated to completion against that total.

## Institution adapter interface

An adapter is the unit of contribution and the unit of reuse. It knows one
institution and nothing about the store.

```
discover(session)  -> inventory of available documents and export ranges,
                      with the provider's own count where one is reported
acquire(selection) -> raw bytes written to the raw tree, plus an acquisition
                      manifest entry: period, capture time, content hash, gaps
parse(raw_file)    -> normalized rows with per-field locators, amounts as
                      strings, original currency preserved
capabilities()     -> which of {structured API, tabular export, PDF statement,
                      trade confirmation} this institution supports, retention
                      window, and known quirks
```

Three capability tiers exist and an adapter declares which it implements. A
structured activity API is richest and usually carries per-trade price. A
tabular export from a download control is simpler and more stable across site
redesigns; it is a cross-check on an API rather than a replacement, and for a
small institution it is sufficient on its own. PDF statements and trade
confirmations are the archival ground truth and the only source that survives
the site changing, so they are acquired for the full retention window once.

Adapters run in a browser session a person has already authenticated. An
adapter never stores a credential, and credentials never appear in adapter
configuration, journals, logs or fixtures. Where a provider reports its own row
or document total, the adapter returns it and the importer asserts against it.

Every adapter ships with synthetic fixtures that exercise its parser without a
real account. Whether a given institution's adapter is published or kept local
is a per-adapter decision recorded in its own directory.

## Data model

SQLite. Dates are ISO `YYYY-MM-DD` text. Money is exact: integer minor units or
canonical base-10 decimal strings, one policy chosen and stated in the README,
never binary floating-point at any point in parsing, normalization or
aggregation.

```
institutions(id, name, slug)

accounts(id, institution_id, acct_last4, display_name, account_type,
         program, registration, owner_entity_id, is_pledged,
         base_currency, opened_date, closed_date, notes)

instruments(id, symbol, cusip, isin, name, instrument_kind, asset_class,
            issuer_note)

transactions(id, account_id, trade_date, process_date, settle_date,
             date_precision, activity_type, description,
             instrument_id, quantity, price, amount, currency,
             amount_base, fx_rate, running_balance,
             source_document_id, source_locator, row_hash UNIQUE,
             provider_txn_id, status, imported_at)

positions(id, account_id, as_of, instrument_id, quantity, price,
          market_value, cost_basis, unrealized, currency,
          valuation_basis, valuation_note, source_document_id, source_locator)

balances(id, account_id, as_of, total_value, cash, currency,
         period_start_value, period_end_value, source_document_id, source_locator)

liabilities(id, institution_id, account_id, kind, display_name, balance,
            currency, rate, as_of, collateral_note, source_document_id, source_locator)

commitments(id, account_id, instrument_id, committed, called, outstanding,
            distributed, currency, committed_original, currency_original,
            fx_rate, status, as_of, source_document_id)

documents(id, institution_id, account_id, doc_type, doc_date, file_path,
          sha256, text_path, parsed_ok, notes)

import_runs(id, started_at, finished_at, source, files_seen, rows_inserted,
            rows_skipped, reconciliations_passed, reconciliations_failed,
            review_items, notes)

reconciliations(id, account_id, period_start, period_end, expected_change,
                computed_change, delta, status, notes)

review_items(id, kind, account_id, source_document_id, source_locator,
             raw_value, reason, status, resolved_at, resolution_note)
```

Only the last four digits of any account number are stored. Raw documents keep
whatever they contain and are not redacted.

`row_hash` is the deduplication key: a hash over account, process date,
activity type, description, quantity and amount. Overlapping pages from a
paginated activity API are normal and a naive import double-counts. A provider
transaction ID is preferred where one exists and is stable; the hash is the
fallback. Equal date, amount and description is not proof of duplication, so
repeated equal amounts on distinct source rows are preserved.

### Fields that exist for extensibility

Three parts of the model are designed in and left unpopulated in v1. They cost
nothing now and cannot be retrofitted cheaply later.

- **Currency on every money column, plus `currency_original`, `fx_rate` and
  `amount_base`.** Totals group by currency. No implicit conversion is ever
  performed. A commitment denominated in one currency and called in another
  records both sides and the rate used.
- **`positions.valuation_basis`.** One of market price, last round, cost, or
  reported NAV, with a `valuation_note`. Without it, a total-assets query
  silently mixes marked securities with positions carried at cost. This matters
  more the more of a portfolio is illiquid.
- **`commitments`.** Committed, called, outstanding and distributed. A
  commitment is not a transaction and has no representation in a pure ledger.
  Fund and private investment tracking is unanswerable without it, and listed
  brokerage holdings never need it.

`accounts.owner_entity_id` and `instruments` carry stable identity so an
account, a property, an institution and a person can be joined to Kith Mind
entities later. Entity resolution itself is deferred; the columns are not.

## Reconciliation gate

For every account and every statement period:

1. Extract stated period start and end values from the statement.
2. Sum transaction amounts over that window.
3. Compare expected against computed change. Market movement makes this exact
   only for cash-like balances, so for investment accounts reconcile the cash
   balance rather than total value.
4. Write a `reconciliations` row. Status is pass within a documented tolerance,
   otherwise fail.
5. Report failures prominently in the import log and the README status section.
   The affected period is queryable as unverified.

Every run additionally asserts that unique row-hash count equals inserted row
count, that every transaction resolves to an account, and that any bulk pull
matches the provider's own reported total for that range.

A date outside a plausible range or in the future is a `review_items` entry,
not a hard failure. A commitment ledger legitimately records a scheduled future
call, and a mistyped year in a hand-maintained source is a correction to
surface rather than a reason to abort an import.

## Holdings and how they are validated

Holdings are v1. They arrive from two independent directions and the two must
not be conflated.

**Stated holdings** are the positions, balances and liabilities parsed from a
statement. They are authoritative, they are what the archive reports, and every
row cites the document it came from.

**Derived holdings** are quantity per instrument replayed from transactions.
They are a gate, not a second source of truth. The archive never reports a
derived holding as fact.

The gate is the position-side analogue of the cash reconciliation above. Cash
compares a stated balance change against summed transaction amounts. Positions
compare a stated quantity change against summed transaction quantities, per
instrument, per period.

Three constraints keep it from failing constantly and being ignored, which is
the only way a gate really dies:

- **Anchor on the prior stated position, never on zero.** Acquired history
  rarely reaches the account's opening, so a comparison derived from zero would
  fail every period forever and teach everyone to skip it. Reconcile the change
  between two consecutive snapshots, exactly as the cash gate diffs two balance
  snapshots. A mismatch then means a missing or duplicated transaction inside
  that window, which is a real finding.
- **Quantity only. Cost basis is not gated.** Quantity is additive and exactly
  reconcilable. Cost basis depends on lot selection, wash sales, return of
  capital and the provider's own adjustments, and tax-lot matching is deferred.
  Record a stated basis, route divergence to review, and never fail a period on
  it.
- **Corporate actions are the position-side equivalent of an activity that
  moves no cash.** A split changes quantity with no transaction behind it.
  Under an exact tolerance those periods fail until the action is modelled,
  which is the gate surfacing a modelling gap rather than absorbing one.

A quantity reconciliation also reports coverage rather than only correctness.
When derived change cannot explain stated change because history does not reach
far enough back, that is a measurement of how much history is missing, and it
belongs in coverage rather than being silently tolerated.

Ongoing maintenance needs no browser session. A statement carries both its
positions table and its activity table, so each new document reconciles itself.

## Access for assistants

v1 exposes a local read-only MCP server over the archive file:

| Tool              | Behavior                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `describe_schema` | Table and column documentation, money policy, currency policy, valuation-basis meanings.                                              |
| `run_query`       | Read-only SQL against the archive. Bounded row count and time. No write path, no attach, no file access.                              |
| `get_evidence`    | For a row, the source document, locator, content hash and a path to the retained text.                                                |
| `get_coverage`    | Per account and period: what was acquired, what parsed, what reconciled, what is under review, and when each source was last updated. |

Every response carries the dataset revision and an explicit completeness state.
A partial or truncated result is never labeled complete. Zero rows with unknown
coverage means no indexed match, not proof that no event occurred.

Coverage is reported at the same granularity as the record contract requires,
so the later Kith Mind adapter wraps this surface rather than re-deriving it.

## Working on the archive without reading it

The archive is large. A single institution's activity history runs to tens of
thousands of rows and its document set to thousands of pages. None of that
belongs in an agent's context, during development or afterwards.

- Acquisition writes provider responses and documents straight to the raw tree.
  A response is never returned through an agent on its way to disk.
- Parsing and import are scripts. An agent runs them and reads their summary:
  files seen, rows inserted, rows skipped, reconciliations passed and failed,
  review items opened.
- Verification uses aggregates. Counts, sums, hashes and reconciliation deltas
  answer whether an import is correct. A row dump does not.
- The review queue is the exception and is bounded by design. Items surface
  individually because a person or an agent has to judge them.

This is a correctness rule as much as a cost one. An agent that has read a
sample of rows is prone to generalizing from the sample, which is the failure
mode the reconciliation gate and the never-assert-absence rule exist to prevent.

## Sequence

**v1 is initial ingestion and assistant access.** Idempotent re-import and the
reconciliation gate belong here, not in v2. Re-import is a property of the
importer and gets exercised dozens of times during development, and an archive
that answers before it reconciles answers confidently and wrongly.

| Task | Deliverable                                            | Acceptance                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-1 | Store, schema, migrations and money policy             | Schema created from migrations. Exact-arithmetic tests over decimal strings. Round-trip tests for multi-currency rows. Documented money and rounding policy in the README.                                           |
| F1-2 | Adapter interface and synthetic reference adapter      | A synthetic institution implements all three capability tiers against generated fixtures. No real account required to run the suite.                                                                                 |
| F1-3 | Importer with provenance, dedupe and review queue      | Repeated import of the same raw tree inserts nothing new. Overlapping paginated pages deduplicate. Provider totals are asserted. Ambiguous values enter review rather than being guessed.                            |
| F1-4 | Reconciliation gate                                    | Synthetic statements with a known injected discrepancy fail the gate and mark the period unverified. Passing periods are marked verified with the tolerance recorded.                                                |
| F1-5 | First real institution adapter and initial acquisition | Full available retention window acquired to the raw tree with an acquisition manifest. Structured and tabular sources cross-checked against each other. Every pull reconciled against the provider's reported total. |
| F1-6 | Local read-only MCP server                             | The four tools above. Read-only enforcement tested against write, attach and file-access attempts. Coverage and completeness states verified against a deliberately partial fixture.                                 |
| F1-7 | Remaining institution adapters                         | Each declares capabilities, ships fixtures, and records its quirks. An institution with a clean tabular export uses it and skips API work.                                                                           |

Three tasks were added after the original sequence, because building F1-1
through F1-7 in parallel left responsibilities that no single task owned.

| Task  | Deliverable                           | Why it was missing                                                                                                                                                                                               |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1-16 | Holdings extraction and import        | Holdings are v1, but F1-2 returned activity rows only, F1-3 imported only transactions, and F1-4 reads `balances` that nothing wrote. The gate had no input on real data.                                        |
| F1-17 | Position quantity reconciliation gate | The validation half of holdings, described above.                                                                                                                                                                |
| F1-18 | Raw tree writer                       | Provenance linkage was complete but nothing persisted acquired bytes, so `documents.file_path` recorded a path no code created and `text_path` was never populated. Evidence pointed at files that did not exist. |

The pattern is worth recording rather than only fixing: each gap sat exactly
where two parallel tasks met, and each was invisible from inside either one.

v1 is done when a single query against the archive reproduces, with no browser:
fees paid over a trailing twelve months by account and fee type; every purchase
of a given instrument class with date, quantity, price and maturity; current
positions with cost basis by account and asset class, each labeled with its
valuation basis; and total assets and liabilities as of the most recent
statement date. Every period in `reconciliations` is either passed or
explicitly flagged.

**v2 is freshness and integration.**

| Task  | Deliverable                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-8  | Drop-folder top-up: a single entry point that scans an inbox, imports what is new, skips what is already hashed, runs the gate and writes a log.  |
| F1-9  | Coverage and freshness reporting, including staleness per source and an actionable reminder for the human acquisition step.                       |
| F1-10 | Kith Mind read adapter or deliberate read projection, using stable archive IDs, revision checkpoints, idempotent updates and deletion tombstones. |
| F1-11 | Additional record kinds where a source introduces them, including commitment tracking from a maintained spreadsheet.                              |

No scheduled scraper is built. If a scheduled agent participates at all, its
job is running the import and reminding a person to do the acquisition.

## Local now, cloud later

v1 runs on one machine. The archive file, the raw tree and the MCP server are
all local. That is a starting point chosen because it is the simplest thing
that works, not a position that this data must never be hosted.

Running the archive as a cloud service later is explicitly open. It buys real
things: access from any device rather than only the desktop, and a durability
problem a provider solves rather than the owner. Sensitive financial data lives
in hosted services routinely and the protections for doing it are well
understood. How a hosted deployment is secured is a decision to make when that
move is made, with client-side encryption before upload as one option among
several rather than a precondition.

What v1 spends now to keep that option open:

- Money is exact integer minor units and canonical base-10 decimal strings, and
  dates are ISO text. Nothing depends on a SQLite-specific numeric type, so
  moving to a hosted engine is a migration rather than a redesign.
- Accounts, instruments, transactions, documents and source revisions carry
  stable opaque identities that survive a move.
- The read surface is one versioned boundary. Hosting changes where the server
  runs, not what it answers.

What that move introduces and v1 deliberately does not solve: authentication
and authorization on the read surface, which is single-user and local today;
network exposure, since a database port is never published directly; and the
multi-user scope the record contract already reserves. The typed-bounded-query
rule that this plan sets aside for a local single-user surface applies again
the moment that surface is reachable from anywhere else.

A single local copy of an acquired retention window is still the one loss this
design cannot recover from, because an institution may not serve its oldest
periods indefinitely. That is a durability requirement whatever the answer to
hosting turns out to be.

## Repository and privacy boundary

The code is public and MIT. The data is not in the repository at any point.

Public: the store, schema and migrations; the adapter interface; adapter
implementations and their synthetic fixtures; the importer, reconciliation gate
and MCP server; the README and this plan.

Outside the repository: the archive file, the raw document tree, import logs,
and any configuration naming a real path, institution account, program, person
or balance. These are local for now, which is a starting point rather than a
rule against an off-machine copy or a hosted deployment; see "Local now, cloud
later". Institution-specific extraction notes that reference a real account
inventory stay in the gitignored private documentation tree.

Public examples use root aliases and synthetic institutions. No real account
number, balance, holding, advisor, entity or file path appears in the public
repository, in fixtures, in test names, or in commit messages. A public clone
runs the full suite with no owner credentials and no private files.

## Deferred

Cross-institution instrument consolidation, tax-lot matching, performance
attribution, automated valuation of illiquid positions, and any write path back
to an institution are out of scope. The schema must make them possible without
requiring them now.
