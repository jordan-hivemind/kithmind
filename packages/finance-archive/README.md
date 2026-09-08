# @repo/finance-archive

The store, schema, migrations and money policy for the financial archive
described in
[`docs/plans/2026-09-07-financial-transaction-database.md`](../../docs/plans/2026-09-07-financial-transaction-database.md).

This package owns the SQLite file and the rules for what a number means inside
it. The adapter interface, importer, reconciliation gate and MCP server build on
top of it.

The archive file, the raw document tree and the import logs live in a configured
local directory outside this repository. No real account number, balance,
holding, institution, advisor, entity or path appears here or in the tests.

## Money and rounding policy

Money has two representations, and which one a column uses follows one rule:
**amounts get summed, prices do not.** Any column added later is classified the
same way.

| Kind                      | Storage                          | Why                                                                                                                                        |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cash amounts              | `INTEGER` minor units            | A total is a plain `SELECT sum(...)` that is exact, with no binary float anywhere in the path. Aggregation is the whole point of a ledger. |
| Quantities, prices, rates | canonical base-10 decimal `TEXT` | These are multiplied and compared, never aggregated, so they keep the full precision the source stated.                                    |

Binary floating point must not appear at any point in parsing, normalization or
aggregation. No `parseFloat`, no `Number` on a money string, no `REAL` column.
The `CHECK (typeof(...) IN ('integer', 'null'))` and `('text', 'null')`
constraints in the schema enforce the storage class, so a parser that produces a
float fails at write time rather than in a wrong total months later.

### Minor units

The scale of an amount is the ISO 4217 exponent of that row's own currency: 2
for USD and EUR, 0 for JPY, 3 for KWD. `currencyExponent` reads a closed table
and throws on an unknown code, because assuming 2 for JPY is the exact bug the
table exists to prevent. Add a currency to `CURRENCY_EXPONENTS` when an
institution needs it.

Amount columns: `transactions.amount`, `transactions.amount_base`,
`positions.market_value`, `positions.cost_basis`, `positions.unrealized`,
`balances.total_value`, `balances.cash`, `balances.period_start_value`,
`balances.period_end_value`, `liabilities.balance`, `reconciliations`
(`expected_change`, `computed_change`, `delta`, `tolerance`) and `commitments`
(`committed`, `called`, `outstanding`, `distributed`, `committed_original`).

Decimal columns: `transactions.quantity`, `transactions.price`,
`transactions.fx_rate`, `transactions.running_balance`, `positions.quantity`,
`positions.price`, `liabilities.rate`, `commitments.fx_rate`.

### Canonical decimal form

One number has exactly one spelling, because `row_hash` hashes over quantity and
amount and an unstable spelling silently breaks deduplication.

- a single leading `-` for negatives, never `+`,
- no leading zeros, except the single `0` before a decimal point,
- no trailing decimal point,
- no trailing zeros in the fraction,
- zero is `0`, never `-0` or `0.00`,
- no exponent notation, no separators, no currency symbols.

So `+1.50`, `007`, `.5` and `-0.000` are accepted on input from a source and
stored as `1.5`, `7`, `0.5` and `0`. Trailing zeros carry no information about
the value; the raw document keeps whatever it stated and is never edited.

### Rounding

**No rounding on ingest, ever.** The archive stores what the document states. A
value with more precision than its currency's minor units is not rounded into
place: `toMinorUnits` throws, and the importer writes NULL plus a `review_items`
note. Ambiguous money is missing, never inferred (ground rule 5).

Rounding is only ever applied to a value the archive derived itself, today only
`amount_base` computed from `fx_rate`. Such a value records the rule it used in
`transactions.amount_base_rounding`. The rule is `half_even`
(`DERIVED_ROUNDING_RULE`), applied by `roundToMinorUnits`.

### Currency

Every money column carries a currency, and totals group by currency. No implicit
conversion is ever performed. `sumMinorUnits` throws rather than adding two
currencies, so a mixed total is a loud failure instead of a plausible number.

## Deduplication

`rowHash` is the deduplication contract. It hashes over account, process date,
activity type, description, quantity, amount and an occurrence ordinal, using
canonical forms, with the currency included because an amount in minor units
has no meaning without the scale its currency gives it. Activity type is
lowercased and whitespace inside descriptions is collapsed, since PDF
extraction varies the gaps between runs. A provider transaction ID is
preferred where one exists and is stable; the hash is the fallback.
`transactions.row_hash` is `UNIQUE`.

The occurrence ordinal is what lets one hash formula satisfy two opposite
requirements at once: the same transaction reappearing on an overlapping page
must dedupe, and two really-distinct transactions that happen to share a date,
amount and description must not merge. It is a hashed field, computed by the
importer as "how many times has this exact content been seen so far in this
one source document, in document order" (first occurrence is 1) — never
appended to a hash after the fact, because a suffix appended post-hoc would
make `row_hash` stop being a hash of the row's content and would make "unique
row_hash count equals inserted row count" true by construction instead of a
real invariant. See `src/importer.ts` for the full reasoning and worked
examples.

## Institution adapter interface

`InstitutionAdapter` (`src/adapter.ts`) is the published contract for one
institution: `discover`, `acquire`, `parse`, `capabilities`. It is the only
part of this package a third party is expected to write, and the only part
meant to be read without also reading the store. An adapter imports no
schema, opens no database file, and returns data for an importer to write.

No adapter handles a credential. A person authenticates a browser session out
of band; `AdapterSession` hands the adapter two functions to read through that
session (`fetchText`, `fetchBytes`) and nothing else, so there is no field to
put a cookie, header or token in even by accident.

`discover` never lets a caller mistake a partial result for a complete one.
Its document inventory is a `Listing<T>`, built only through
`exhaustiveListing` (which throws unless the items actually reconcile against
the provider's stated total) or `incompleteListing` (which carries why it
stopped, and a `providerTotal` of `null` when the provider states no total at
all, distinct from a stated total of `0`).

`acquire` returns the raw bytes it captured, unedited, plus a manifest entry:
period, capture time, a sha256 content hash (`sha256Hex`), the row count the
provider claimed for the pull when it claims one, and any gaps the pull
could not close. Writing those bytes to the raw tree is the importer's job,
not the adapter's; the raw tree stays immutable either way.

`parse` returns `ParsedRow[]`: quantity, price and amount are canonical
decimal text or `null`, never a `number`, and an amount that could not be
read is `null` with a required `amountNote` rather than a guess. Every row
carries a `locators` map keyed by field name, so a row and, where it matters,
one ambiguous field on that row can each be traced back to a page, line or
API row in the source.

`capabilities` declares which of the four sources
(`structured_api`, `tabular_export`, `pdf_statement`, `trade_confirmation`)
an adapter actually implements, its retention window, and free-text quirks.
An adapter declaring a subset honestly is the expected case, not an
incomplete one.

`src/adapters/syntheticTrust/` is the reference implementation: a wholly
invented institution ("Thistlebrook Trust") implementing all four sources
against fixtures generated in `fixtures.ts`, including a paginated activity
feed with a deliberate page-boundary overlap and one deliberately
unparseable statement amount. `test/syntheticAdapter.test.mjs` is what a new
adapter's own suite should look like.
## Importer

`importBatch(db, batch, now?)` turns normalized rows into `documents`,
`transactions` and `review_items`, and writes one `import_runs` summary. It is
a script, not something an agent reads rows through: it returns counts, never
row content (see "Working on the archive without reading it" in the plan).
The whole batch commits or rolls back as one transaction, so a provider-count
mismatch or a broken invariant never leaves a partially-imported archive.

`ImportRow` is the row shape it consumes, not an adapter interface. It is the
seam an institution adapter's `parse()` output gets mapped to; see the type's
doc comment in `src/importer.ts` for every field. In short: `accountId` must
already exist, `processDate` is a required ISO date, amounts are decimal text
in the row's own currency, and `providerTxnId` is a stable per-account id from
the source when one exists.

Deduplication follows the plan exactly: a stable `providerTxnId` is the
preferred, authoritative identity and is what correctly collapses an
overlapping page from a paginated pull regardless of row order. Without one,
the importer looks up the computed `row_hash` (content plus the per-document
occurrence ordinal, see "Deduplication" above) before inserting; a match found
in a different document is skipped as a duplicate rather than colliding at
write time, and because that collapse rests on content evidence rather than a
stable id, it opens a `review_items` entry recording both source locators
instead of happening silently. A match within the same document cannot
happen, since every occurrence in one document gets its own ordinal, which is
exactly how two legitimately identical transactions (same date, amount,
description) both survive. Re-importing the same raw bytes is a no-op at the
whole-document level, keyed on `documents.sha256`, checked before any of this.

A value `toMinorUnits` cannot place at the currency's exponent, a malformed
quantity, price, running balance, trade date or settle date, an unparseable
process date, a future date, or a date before 1900 each open a `review_items`
row instead of being guessed. Only an unparseable process date blocks the
transaction from being inserted at all, because `process_date` has no other
spelling to store; every other case stores what the source stated (or NULL
for the field in question) and flags it.

This importer always writes `reconciliations_passed` and `reconciliations_failed`
as 0; the reconciliation gate is a separate step run after import (see below).

## Reconciliation gate

`runReconciliationGate(db, importRunId?)` (`src/reconciliation.ts`) is ground
rule 3 made concrete: reconciliation is a gate, not a report. For every
account with two or more `balances` snapshots, it treats each consecutive
pair of snapshots as one statement period, sums that account's transactions
over the period (inclusive of both boundary dates), and compares the sum
against the snapshots' stated cash change. It writes one `reconciliations`
row per period and returns the same information as counts and period-level
facts, never a transaction row.

**The comparison is always cash, never total value.** Market movement makes
an exact diff possible only for a cash-like balance: an unrealized gain or
loss on a held security changes `total_value` without ever appearing as a
transaction, so comparing against `total_value` would fail an investment
account's every period on ordinary market movement. This file never reads
`total_value`, `period_start_value` or `period_end_value` at all, so there is
nothing in it that could compare against them by mistake. For a cash-only
account (checking, savings) `cash` is the account's only balance, so the same
comparison is correct there unchanged.

**The tolerance is exact zero**, an owner decision, not a default: any
nonzero delta fails the period. `reconciliations.tolerance` is written on
every row, passing or not, so a future policy change can never silently
reinterpret an old pass. A period is `pass` when the delta is exactly zero,
`fail` when transactions were summed but do not explain the stated change,
and `unverified` when no verdict could be computed at all -- a snapshot
missing its cash value, or a currency change between snapshots. `fail` and
`unverified` both count toward `import_runs.reconciliations_failed`: neither
is a clean pass, and the table has no third bucket. A consumer finds every
period needing attention with `SELECT * FROM reconciliations WHERE status !=
'pass'`, which is exactly what `get_coverage` already does per account.

This gate does not populate `balances`; writing what a statement stated is a
separate concern from checking it. Re-running after a corrected import is
idempotent: any prior row for the same account and period is replaced, not
added to.

## Wiring an adapter to the importer

`src/adapterImport.ts` is the seam between `ParsedRow` (what an adapter's
`parse()` returns) and `ImportRow`/`ImportDocument` (what `importBatch`
consumes); neither the adapter interface nor the importer owns this mapping
on its own. `adapterPullToImportDocuments(db, pull)` does two things a
caller cannot do by combining the other two files alone:

- **Instrument resolution.** `ParsedRow.instrument` is a descriptor (symbol,
  cusip, isin, name); `resolveInstrumentId` turns it into a stable
  `instruments.id`, creating the row the first time it is seen. Precedence:
  `cusip`, then `isin`, then `symbol` and `name` together, then `symbol`
  alone, then a new row. A real identifier never merges two different
  instruments that happen to share a ticker. A bare symbol with no cusip,
  isin or matching name resolves to the *existing* instrument with that
  symbol (deterministically the first one ever created, by SQLite `rowid`)
  rather than minting a new row every time -- unbounded row growth would
  silently break "every purchase of instrument X" just as badly as a wrong
  merge would -- and every such weak match opens a `review_items` entry
  (`kind = 'weak_instrument_match'`) naming the symbol and which row it
  matched, the same way a cross-document `row_hash` collapse is made
  visible instead of happening quietly.
- **Document splitting.** `ParsedRow.sourceDocument` tells the wiring layer
  which underlying document (a page of a paginated pull, or the one file for
  a statement, confirmation or tabular export) each row belongs to. A pull
  that is one document end to end becomes one `ImportDocument`; a paginated
  pull becomes one `ImportDocument` per page, so the importer's
  per-document `occurrence` ordinal is scoped to the right boundary and the
  same real transaction on an overlapping page lands on a matching ordinal
  in each page's document. See `ParsedRow.sourceDocument`'s doc comment in
  `src/adapter.ts` for the full reasoning. Splitting loses the single
  provider-reported total the un-split case can assert directly, so
  `adapterPullToImportDocuments` checks it separately across the whole pull:
  it recomputes each page's `occurrence` ordinal and `row_hash` the same way
  `importBatch` will (via `contentKey` in `rowHash.ts`, shared by both so
  they cannot drift apart) and compares the distinct-hash count against the
  provider's total -- this works whether or not the rows carry a provider
  transaction id, unlike checking distinct ids alone, which goes silent the
  moment a source has none. When the provider states no total at all for a
  paginated pull, ground rule 7 forbids asserting completeness anyway: the
  pull still imports, but opens a `review_items` entry
  (`kind = 'unverified_pagination_total'`) rather than passing silently, so
  that pull's completeness is never later assumed.

Two other renames happen here, not upstream: `ParsedRow.externalId` becomes
`ImportRow.providerTxnId` (same concept), and `ParsedRow.locators` (a
per-field map) is JSON-encoded into the single `ImportRow.sourceLocator`
string rather than collapsed to just the row locator, so per-field
provenance survives into `transactions.source_locator` even though the
column itself stays a single opaque string. `ParsedRow.amountNote` -- the
required reason behind a `null` amount an adapter could not read -- passes
through as `ImportRow.amountNote`; the importer opens a `review_items` entry
for it exactly as it does for an amount `toMinorUnits` rejects, rather than
letting it vanish.

## Schema and migrations

`openArchive(path)` opens the file, sets `foreign_keys`, WAL and a busy timeout,
and applies any migration the file has not seen. The applied version is recorded
in the file with `PRAGMA user_version`, each migration runs in one transaction,
and running migrations twice is a no-op. Opening a file written by a newer build
is an error rather than a silent downgrade.

Add a schema change as a new entry in `MIGRATIONS` with the next version number.
Never edit a migration that has shipped.

Only the last four digits of an account number are stored, in
`accounts.acct_last4`, enforced by a `CHECK` constraint.

## Local read-only MCP server

`src/mcp` is the v1 assistant access surface described in the plan: a local,
read-only [MCP](https://modelcontextprotocol.io) server over one archive
file, run as `pnpm --filter @repo/finance-archive mcp` after a build, with
`FINANCE_ARCHIVE_DB_PATH` set to the archive file. That path is read from the
environment only; it is never committed and the server never defaults to a
location.

Four tools: `describe_schema` (table and column documentation, plus the
money, currency and valuation-basis policy), `run_query` (read-only SQL,
bounded rows and time), `get_evidence` (source document, locator, content
hash and retained-text path for one row), and `get_coverage` (per account:
what was acquired, parsed, reconciled, and under review). Every response
carries `datasetRevision` (SQLite's own `data_version`, which changes when
the importer writes the file) and an explicit `completeness` state; a
truncated `run_query` result is marked `truncated`, never `complete`, and a
zero-row result always carries `resultSemantics` explaining that it means no
indexed match, not proof that nothing happened.

`run_query` enforces read-only in depth rather than by inspecting the SQL
string: the file is opened `SQLITE_OPEN_READONLY`, `PRAGMA query_only` and
defensive mode are both on, and an authorizer callback allow-lists `SELECT`,
table/column reads and a small function list, denying every write, every DDL
verb, `ATTACH`/`DETACH`, every `PRAGMA`, and file-access functions like
`readfile` -- including one hidden inside a `WITH` clause or a subquery. A
single-statement check on top of that, using SQLite's own parser rather than
a regex, rejects a second statement smuggled after a semicolon or inside a
comment. See `src/mcp/queryGuard.ts` for the full layer list and
`test/mcpQueryGuard.test.mjs` for the attack-by-attack tests.

## Checks

```
pnpm --filter @repo/finance-archive build
pnpm --filter @repo/finance-archive test:once
```

The suite creates its databases in a temp directory and removes them. A public
clone runs it with no credentials and no private files.
