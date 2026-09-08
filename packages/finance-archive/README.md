# @repo/finance-archive

The store, schema, migrations and money policy for the financial archive
described in
[`docs/plans/2026-09-07-financial-transaction-database.md`](../../docs/plans/2026-09-07-financial-transaction-database.md).

This package owns the store and the rules for what a number means inside it.
The adapter interface, importer, reconciliation gate and MCP server build on
top of it.

The archive is moving from a local SQLite file to hosted Postgres, so an
always-on machine and a laptop can share one archive. F1-20 adds the Postgres
schema, the money representation it uses and the conversion tests beside the
SQLite implementation; F1-22 ports the importer, both reconciliation gates and
the raw-tree writer onto it and removes SQLite. Until then both are here, and
the sections below say which engine each describes.

The archive file, the raw document tree and the import logs live in a configured
local directory outside this repository. No real account number, balance,
holding, institution, advisor, entity or path appears here or in the tests.

## Money on Postgres (F1-20)

SQLite forced a split representation: cash amounts as integer minor units so
`SUM` stayed exact, quantities and prices as canonical decimal `TEXT` so
precision survived. Postgres `NUMERIC` does both, so one representation
replaces the split and the conversion boundary between them disappears along
with the class of bugs that lived on it.

**`NUMERIC` does not make money exact end to end.** It gives exact arithmetic
and exact aggregation inside the database. It does nothing about precision
lost _before_ insertion: a JavaScript `0.1 + 0.2` arrives as
`0.30000000000000004` and is stored faithfully, damage included. So the
guarantee is validated input and pinned decoding, and both are built rather
than assumed.

| Rule                                                     | Where it lives                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Decimal input is validated as text before any conversion | `toNumericText` (`src/pgNumeric.ts`)                                 |
| A JavaScript number is refused, never stringified        | `toNumericText`                                                      |
| Non-finite values are refused, Postgres `NaN` included   | `toNumericText`, `fromNumericText`, and the `finance_numeric` domain |
| Money crosses driver, JSON and MCP boundaries as text    | `pinNumericDecoding` (`src/pgStore.ts`)                              |

The SQLite `CHECK (typeof(...))` constraints do not translate, because
Postgres types already cover storage class. Their intent moves to input
validation, which is the only place that can still tell a float from a
decimal.

### Overflow

Columns are `NUMERIC` with no declared precision or scale. `NUMERIC(38, 18)`
would _round_ a more precise value into place on insert, which is the silent
loss the policy exists to prevent. The typed Kith Mind boundary carries 38
significant digits and 18 fractional places, and that bound is enforced on the
way in by `toNumericText`, where exceeding it throws. A caller turns that into
a `review_items` row, exactly as it already does when `toMinorUnits` cannot
place a value at a currency's exponent. Out of range is a rejection or a
review outcome, never a rounding.

### Driver decoding

node-postgres decodes by type OID, and its current default for `NUMERIC` is
already text. That is why the decoder is pinned rather than relied on: a
default is a choice someone else can change in a minor release, and a driver
that silently started returning a float for `NUMERIC` would reintroduce the
exact failure the type was chosen to prevent, quietly and everywhere at once.
`pinNumericDecoding` pins `NUMERIC` and `INT8`, and `test/pgMoney.test.mjs`
asserts the pin with no database required.

### The deduplication preimage is versioned

`row_hash` hashed the minor-unit integer. Under a decimal representation `1`,
`1.0` and `1.00` must resolve to one identity, or deduplication stops working
and the archive double-counts. So the preimage is versioned, not quietly
changed:

| Domain                | Amount field in the preimage                                      |
| --------------------- | ----------------------------------------------------------------- |
| `kith-finance-row:v1` | minor units at the currency's exponent, USD 12.34 as `1234`       |
| `kith-finance-row:v2` | the stated amount in canonical decimal form, USD 12.34 as `12.34` |

`fromMinorUnits(amount, currency)` is the mapping between them. It is total
and, for a fixed currency, injective, so two rows share a v1 hash if and only
if they share a v2 hash: the identities the archive deduplicates on are the
same set before and after the move. `test/pgMoney.test.mjs` asserts that
property over a synthetic row set covering a zero-exponent currency, a
three-place one, repeated content at different ordinals, an ambiguous amount
under review and several spellings of one amount.

`rowHash` and `ROW_HASH_DOMAIN` still mean what they meant. `rowHashV2` and
`ROW_HASH_DOMAIN_V2` are new names, so nothing reinterprets a v1 hash as a v2
one. The occurrence ordinal and its runtime validation carry over unchanged:
it is what lets one formula both collapse an overlapping paginated page and
keep two legitimately identical transactions in one document apart.

## Money and rounding policy (SQLite)

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

`acquire` returns the **retained** bytes plus a manifest entry: period,
capture time, the sha256 of those retained bytes, the row count the provider
claimed for the pull when it claims one, and any gaps the pull could not
close. Retained, not raw: see "Retention projection" below. Writing the bytes
to the raw tree is the importer's job, not the adapter's; the raw tree stays
immutable either way.

`parse` returns a `ParsedPull`: `{ activity, holdings }`. `activity` is
`ParsedRow[]` as before: quantity, price and amount are canonical decimal
text or `null`, never a `number`, and an amount that could not be read is
`null` with a required `amountNote` rather than a guess. Every row carries a
`locators` map keyed by field name, so a row and, where it matters, one
ambiguous field on that row can each be traced back to a page, line or API
row in the source.

`holdings` is `{ positions, balances, liabilities }`: what a statement's
positions table and summary section state, alongside its activity table, from
the one parse of that document's bytes. An adapter with only activity (a
structured API, a tabular export, a single trade confirmation) declines
honestly with `EMPTY_HOLDINGS` rather than inventing a positions table it does
not have. Every holdings row carries its own `sourceDocument`, the same field
`ParsedRow` uses, so a holding lands on the right `ImportDocument` even when a
pull's activity is paginated and its holdings are not (the normal case: a
statement's positions table is never itself paginated).

`ParsedPosition.marketValue` follows the same ground-rule-5 pattern as
`ParsedRow.amount`: decimal text or `null` with a required
`marketValueNote`. `costBasis` and `unrealized` are secondary and optional,
plain decimal text or `null`. `valuationBasis` is one of `market_price`,
`last_round`, `cost` or `reported_nav`, or `null` when the source does not
say; `valuationNote` is always required text, explaining the basis when one
is known and explaining why it is unknown when it is not. A `null`
`valuationBasis` is never silent: the importer opens a
`weak_instrument_match`-style review item (`ambiguous_valuation_basis`) for
it, because the plan is explicit that a total-assets query with no valuation
basis silently mixes marked securities with positions carried at cost.

`ParsedRow.quantity` is signed by direction: positive for an acquisition,
negative for a disposal, whatever the source calls the activity. A sale of
ten shares is `"-10"`, not `"10"` with the sign carried on `amount` alone.
The position gate replays these quantities against a stated position change,
and the sign cannot be recovered downstream from `activityType`, which is
free provider text with no taxonomy behind it.

`capabilities` declares which of the four sources
(`structured_api`, `tabular_export`, `pdf_statement`, `trade_confirmation`)
an adapter actually implements, its retention window, and free-text quirks.
An adapter declaring a subset honestly is the expected case, not an
incomplete one.

`src/adapters/syntheticTrust/` is the reference implementation: a wholly
invented institution ("Thistlebrook Trust") implementing all four sources
against fixtures generated in `fixtures.ts`, including a paginated activity
feed with a deliberate page-boundary overlap, one deliberately unparseable
statement amount, and a positions table on its PDF statement with a
market-marked position, a cost-basis-only illiquid holding, a deliberately
unparseable market value, and a EUR-denominated position alongside the USD
ones. `test/syntheticAdapter.test.mjs` is what a new adapter's own suite
should look like.

## Retention projection

No adapter can hold a credential on the way in: `AdapterSession` is two
functions and nothing else. That closes half of it. A provider can also echo
a credential back **inside a response body** -- a session token, an
`Authorization` header, a `Set-Cookie` value, a refresh token, a device
identifier, a signed-in user profile -- and the raw tree is a synced folder.
`src/retention.ts` closes that half.

An adapter declares what it retains and everything else is dropped. The
declaration is an allowlist, never a denylist, and the projection is built up
from it rather than filtered down from the response: a field the provider adds
next month is not copied, because nothing copies a field that was never named.
There is no list of credential-looking key names anywhere in this package,
deliberately. A denylist fails open exactly once.

| Declaration     | For                                                    | Behavior                                                                                       |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `json_allowlist` | A JSON payload (`structured_api`)                       | Named leaf paths are retained. `*` matches any array index or object key. Everything else is dropped. |
| `opaque`         | `pdf_statement`, `trade_confirmation`, `tabular_export` | Bytes retained whole, with a required stated reason. Refused outright for `structured_api`.       |

A PDF statement is bytes, not JSON. It has no addressable fields, so a field
projection is not a thing that can be applied to it: it is retained whole,
declared `opaque` with a stated reason, and the manifest records `opaque` so
no reader mistakes the file for a filtered payload. The same holds for a
tabular export, which is delimited text a download control produced. `opaque`
is refused for `structured_api`, because a JSON response is exactly the shape
that echoes session state back, and one word must never become a way to opt
out of the allowlist on the tier that needs it.

Three properties follow, and they are the ones worth stating:

- **Hash what you retain.** `retainPayload` produces the bytes and hashes
  those same bytes. The provider's original response is never hashed and never
  stored, and a retained artifact is never normalized back toward the original
  so that two hashes agree. `documents.sha256` is always the hash of the bytes
  on disk.
- **It is impossible, not discouraged.** `writeRawDocument` takes a
  `RetainedPayload`, not a `Uint8Array`. Only `retainPayload` produces one,
  branded at compile time and tracked in a run-time `WeakSet`, so raw provider
  bytes have no route to the raw tree at all. `persistAcquiredDocument`
  re-applies the projection at that seam (it is idempotent, so this is a
  no-op for a correct adapter) and refuses any document whose declared
  `contentHash` does not match the retained bytes.
- **A mismatch is never a silent pass-through.** An undeclared field is
  dropped and opens a `retention_dropped_fields` review item naming the source
  paths -- paths only, never values. A shape the declaration cannot describe
  (a path terminating above a nested value, an array declared without `*`, a
  JSON allowlist over non-JSON bytes) is a `RetentionShapeError` that stops
  the acquisition, because that is an adapter bug rather than a provider
  change.

Money keeps its exact digits across the projection. Every JSON primitive is
captured as its own literal source text and re-emitted verbatim, so a provider
that states an amount as a JSON number with more precision than a double holds
is retained with that precision intact. The money policy above says binary
floating point appears nowhere in the path; this is the one place that
re-serializes a payload, and it keeps that true.

`test/retention.test.mjs` is the negative suite. Its fixture echoes
credential-shaped material back inside the activity response -- a bearer
token, a `Set-Cookie` value, an `Authorization` header echo, a refresh token,
a long opaque session id, a device id and a user profile, every one of them
an obviously fake canary in no real token format -- and asserts against the
**bytes written to the raw tree**, not against what the projection returned.
Nothing in that suite prints a payload.

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

### Holdings (positions, balances, liabilities)

`ImportDocument.positions`, `.balances` and `.liabilities` get the same
provenance and review-queue treatment as `.rows`, with one difference:
`positions`, `balances` and `liabilities` have no per-row dedupe key of their
own (no `providerTxnId`, no `row_hash`), so they dedupe at the whole-document
level instead, the same immutable-raw-file check that already skips a
byte-identical document's transactions (`documents.sha256`, checked before
any row is inserted). Re-importing the same document is a no-op for holdings
exactly as it is for transactions.

Only `as_of` unparseable to ISO blocks a holdings row from being inserted at
all, the same reasoning as `process_date`: the column is `NOT NULL` with no
other spelling to store. Every other malformed or missing field -- quantity,
price, cost basis, unrealized, cash, a liability's rate -- stores `NULL` and
opens a `review_items` row instead of guessing. `positions.market_value`,
`balances.total_value` and `liabilities.balance` follow the transaction
`amount`/`amountNote` pattern: a value that fails `toMinorUnits`, or a value
the adapter never had, opens `ambiguous_market_value` /
`ambiguous_total_value` / `ambiguous_liability_balance`. A `valuation_basis`
outside the four known values, or left `null`, opens
`ambiguous_valuation_basis` rather than being written silently -- this is the
plan's own warning made concrete: an unlabeled position in a total-assets
query is indistinguishable from a labeled one until it is too late.

`positions.account_id` and `balances.account_id` are `NOT NULL` in the
schema; a document that carries a position or balance with no `accountId`
fails the whole batch loudly rather than writing an orphaned row.
`liabilities.account_id` may be `null` (an institution-level liability not
tied to one account).

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

## Position quantity gate

`runPositionReconciliationGate(db, importRunId?)`
(`src/positionReconciliation.ts`) is the validation half of holdings and the
position-side analogue of the cash gate. Run it after
`runReconciliationGate` against the same `import_runs` row:

```ts
const cash = runReconciliationGate(db, runId);
const positions = runPositionReconciliationGate(db, runId);
```

Both increment the same `import_runs` counters. The position gate appends to
`import_runs.notes` rather than replacing it, so the cash gate's note
survives.

Stated holdings are authoritative and are what the archive reports. Derived
holdings -- quantity replayed from transactions -- are a gate and never a
second source of truth, so nothing here writes to `positions` and no derived
quantity is ever reported as a holding.

**What is compared.** For every account and instrument with two or more
stated `positions` snapshots, each consecutive pair of snapshots is one
period. The gate diffs the two stated quantities and compares that against
the sum of `transactions.quantity` for the same account and instrument over
the window, inclusive of both boundary dates, matching the cash gate.
Transaction quantities must be signed: an acquisition is positive and a
disposal negative, which is the adapter's responsibility.

**The anchor is the prior stated position, never zero.** Acquired history
rarely reaches an account's opening, so a comparison derived from zero would
fail every period forever and teach everyone to skip the gate. An account
holding 400 shares whose acquired history begins a decade after it opened
still passes a period in which it bought 25 more.

**Quantity only. Cost basis is not gated.** Quantity is additive and exactly
reconcilable; cost basis depends on lot selection, wash sales, return of
capital and provider adjustments, and tax-lot matching is deferred. This file
never reads `cost_basis`, `market_value`, `price` or `unrealized`, so nothing
in it can fail a period on a basis divergence. A stated basis is recorded by
the importer and any question about it goes to `review_items`.

**Corporate actions fail periods until they are modelled.** A split changes
quantity with no transaction behind it, so under an exact tolerance those
periods fail. That is the gate surfacing a modelling gap, not absorbing one,
and there is deliberately no heuristic that guesses at a split.

**The tolerance is exact zero**, the same owner decision the cash gate
applies, written to `position_reconciliations.tolerance` on every row so a
later loosening cannot silently reinterpret an old pass. Quantities are
canonical decimal `TEXT`, so the comparison goes through `subtractDecimal`
and `compareDecimal`; no quantity passes through `parseFloat`, `Number` or a
`REAL` column at any point.

**Coverage is reported, not tolerated.** A first stated snapshot with no
prior snapshot has no period to check, which is not a failure. But an account
whose transaction history begins after one of its stated positions has a
period that cannot be checked at all, no matter what the sum comes to. Those
periods are `unverified` with a note naming both dates, and the summary's
`coverageGaps` measures the gap per account: the first stated position, where
transaction history actually starts, and how many periods that left
unverified. `get_coverage` reports the same thing per account as
`positions.historyStartsAfterFirstStatedPosition`, alongside
`positionPeriods` status counts. `min(transactions.process_date)` is the
archive's only record of how far back activity was acquired, so it is what
"history starts here" means.

A position with no `instrument_id` is skipped: it has no identity to pair
snapshots on, and pooling such rows would invent a holding.

### Why a separate table

`position_reconciliations` is a table of its own rather than an
`instrument_id` column on `reconciliations`, for two reasons that are not
stylistic. First, a cash change is `INTEGER` minor units and a quantity
change is canonical decimal `TEXT`; the `CHECK` constraints pinning those
storage classes are how a `REAL` from a parser is caught at write time, and
sharing the columns would mean dropping exactly those checks.
`reconciliations.currency` is also `NOT NULL` and meaningless for a share
count. Second, a cash verdict and a position verdict must stay
distinguishable: with one table, every existing `SELECT ... FROM
reconciliations WHERE status != 'pass'` would silently start returning
per-instrument rows and every account's period list would multiply by its
instrument count. Two tables make the distinction the table name, which no
query can miss.

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
  isin or matching name resolves to the _existing_ instrument with that
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

## Raw tree

`acquire` (`src/adapter.ts`) returns bytes and a manifest; it does not write
anything to disk. `src/rawTree.ts` is where those bytes -- and any retained
extracted text -- are actually persisted, per ground rule 1: raw files are
immutable, written once, never edited, never deleted.

The root directory is configuration, read from
`FINANCE_ARCHIVE_RAW_TREE_ROOT` and nowhere else, the same pattern
`src/mcp/run.ts` uses for `FINANCE_ARCHIVE_DB_PATH`: a missing setting is a
hard error naming exactly what is missing, never a default and never a
guessed location. No real path appears in this repository, in a fixture, or
in a test.

Layout is content-addressed:

```
<root>/documents/<sha[0:2]>/<sha[2:4]>/<sha256>
<root>/text/<sha[0:2]>/<sha[2:4]>/<sha256>.txt
<root>/captures/<institutionSlug>/<yyyy>/<mm>/<captureId>-<manifestSha256>.json
```

`documents/` is addressed by the raw bytes' own hash; `text/` is addressed by
the retained text's own hash, in a separate namespace so a text blob and a
raw document can never collide on path even in principle. Content addressing
was chosen over date- or institution-partitioning because it makes two of
this module's hard requirements true by construction instead of by
convention someone could get wrong: identical bytes always land on the same
path, so a repeat write of the same content is caught by the layout itself
rather than a lookup a caller has to remember to run, and two different byte
strings can never collide on a path, because the path _is_ their hash. A 2+2
hex fan-out (65536 buckets) keeps any one directory small at tens of
thousands of documents, which stays fine for a person to browse by hand.
`captures/` is what makes an acquisition, not just a document, identifiable
from the raw tree alone -- see "Captures: separating byte identity from
acquisition provenance" below.

Write-once is enforced with a hard link, not a rename or a plain write:
linking a temp file into the final content-addressed path fails outright if
that path is already occupied, rather than silently overwriting it, so a
repeat acquisition of identical bytes is always a reported no-op
(`status: "already_exists"`), never a rewrite and never a run-aborting
error. Nothing in this module ever deletes an existing raw-tree file.

The content hash is verified twice: once right after writing, against a temp
file read back from disk (catches a bad write before it is ever linked into
the tree), and once again whenever a write lands on a path that already
exists (catches a corrupted prior file rather than silently trusting its
presence). `readAndVerify(path, sha256)` is the same check exposed as a
general-purpose readback function, so a mismatch anywhere -- a bit flip, a
truncated copy, a tampered file -- is a thrown error naming both hashes,
never wrong bytes returned as if they were fine.

`persistAcquiredDocument(db, rawTreeRoot, descriptor, extractedText?)`
(`src/adapterImport.ts`) is the call site: it writes an `AcquiredDocument`'s
bytes, its capture manifest (`src/captures.ts`, see below), and, when
supplied, its retained extracted text, and cross-checks the written sha256
against the adapter's own `manifest.contentHash` -- an adapter that
mis-hashed its own bytes is exactly the kind of bug provenance exists to
catch. `descriptor` names the `institutionId`, `accountId` and `docType` a
pull belongs to (both ids are foreign keys, so a valid one guarantees a real
row to resolve the institution's slug and the account's last four digits
from), plus an optional `captureId` (see below); its result is the _only_
way to obtain an `AdapterPull.persisted` -- `AdapterPull` has no free-form
`filePath` field a caller could invent -- so `documents.file_path`
(`importBatch`, `src/importer.ts`) ends up pointing at a file that actually
exists rather than a path no code ever created, structurally rather than by
a caller remembering to persist first.

`text_path` is populated after the fact, not threaded through
`ImportDocument`/`importBatch` (out of this module's scope): once a
document's raw bytes are imported and its text is written,
`recordRetainedTextPath(db, sha256, textPath)` runs a targeted
`UPDATE documents SET text_path = ... WHERE sha256 = ...`, so `get_evidence`
can return a path to the retained text instead of null.

### Captures: separating byte identity from acquisition provenance (F1-24)

Ground rule 1 does not stop at "raw files are immutable." It also says
structured data is derived and the archive can be rebuilt from scratch. The
archive database is that structured data: lose it, and a directory of
extension-less files named by hash is unlabelled unless the raw tree itself
says what each one is.

An earlier version of this label lived as a `.manifest.json` sidecar keyed on
the *document's* content hash, next to the bytes it described. That is wrong
for the same reason a document is content-addressed and a capture is not:
byte equality is not source identity. The same statement bytes can
legitimately be acquired twice -- two pulls of an overlapping period, a
re-acquisition after a parser fix, the same document reachable from two
endpoints -- and each acquisition has its own time, source, period and
retention declaration. Keying the label on the document's hash meant the
second capture collapsed onto the first one's write-once slot and its
provenance was silently discarded.

`src/captures.ts` gives every capture -- every acquisition event -- its own
record instead, addressed by a capture id rather than by the document it
references: `writeCaptureManifest` writes it, write-once and content-hashed
by its own bytes, at
`<root>/captures/<institutionSlug>/<yyyy>/<mm>/<captureId>-<manifestSha256>.json`,
recording the referenced document's sha256, the institution's slug (not the
database's internal row id, which means nothing once the database that
minted it is gone), the account's last four digits, document type, statement
period, capture time, capability tier, any acquisition gaps, the original
file extension when the source gave one, and the `RetentionRecord`
describing the projection that produced the bytes (see "Retention
projection"): its declaration and version, the projection algorithm version,
and the source paths that were dropped. That last field is how a reader
learns the file is a projection of the provider's response rather than the
response itself. The retention record moved here from the old document
manifest for the same reason as the rest of this section: it describes what
one acquisition did, not a property of the bytes.

`captureId` is one acquisition attempt's own idempotency key --
`persistAcquiredDocument` mints a fresh random one when a caller does not
supply one, which is correct for any caller that is not itself retrying a
specific earlier attempt. Calling it twice with the *same* `captureId` is a
retry of one attempt and is an idempotent no-op, exactly like a repeat
document write; calling it twice with *no* `captureId` (or two different
ones) for identical bytes is two acquisitions, and both keep their own
capture. Reusing a `captureId` for a manifest that would hash differently is
refused outright with `CaptureConflictError` -- a reconciliation problem for
a person to resolve, never something written silently as a second file or
silently dropped.

Many captures may reference one document; each is independently discoverable
by walking `<root>/captures/` -- no database required, the same
"self-describing" property the tree has always had for documents.
`readCaptureManifest` reads one back; `test/captures.test.mjs` covers the
module directly, and `test/rawTree.test.mjs` has a test that persists two
captures of byte-identical content, discards the database entirely, and
confirms both are still identifiable from the raw tree alone.

`ParsedPull.holdings` is mapped the same way, through the same
`resolveInstrumentId` -- there is no second instrument-resolution mechanism
for holdings, `ParsedPosition.instrument` resolves exactly like
`ParsedRow.instrument` does. Each `ParsedPosition`/`ParsedBalance`/
`ParsedLiability` carries its own `sourceDocument`, grouped into
`ImportDocument`s the same way activity rows are, so a holding lands on the
right document even when a pull's activity is paginated and its holdings are
not (the normal case). Ground rule 7's provider-total check stays scoped to
activity rows; `reportedRowCount` is a transaction-row count and holdings
have no analogous provider total to reconcile against.

## Postgres schema (F1-20)

`applyPgSchema(client)` creates the schema in the connected `search_path` and
records the applied version in a `schema_version` table. It is one initial
schema rather than a translation of three SQLite migrations, because there is
no data behind those migrations and that is the whole reason the engine
changes now rather than later. The whole creation is one transaction, a
session advisory lock excludes a second creator by the database rather than by
convention, and running it again is a no-op returning the recorded version.

All twelve tables plus `position_reconciliations` survive, with every
constraint the SQLite schema expressed: currency on every money column,
`positions.valuation_basis` and `valuation_note`, `commitments` designed and
unpopulated, `source_document_id` and `source_locator` on every derived row,
`acct_last4` constrained to exactly four digits, `row_hash` unique, and stable
opaque text identities. Dates become `DATE`, timestamps `TIMESTAMPTZ` and
flags `BOOLEAN`, so the SQLite `GLOB` spelling checks are unnecessary. Two
domains carry the rules that repeat across columns: `finance_numeric` (every
money, quantity, price and rate column, rejecting Postgres's own `NaN`) and
`currency_code`.

`position_reconciliations` keeps its own table. Under SQLite it was separated
partly by storage class, and that reason is gone. The other reason is not: a
cash verdict and a position verdict must stay distinguishable, or every query
for unverified periods silently starts returning per-instrument rows.

The connection string is read from `FINANCE_ARCHIVE_DATABASE_URL` and nowhere
else, the same rule `FINANCE_ARCHIVE_DB_PATH` and
`FINANCE_ARCHIVE_RAW_TREE_ROOT` already follow: a missing setting is a hard
error that names what is missing, never a default and never a guess.

### Running the Postgres tests

`test/pgMoney.test.mjs` needs no database and always runs: input validation,
driver decoding and the whole deduplication preimage are pure logic, and they
are the three places this port can go quietly wrong.
`test/pgSchema.test.mjs` needs a real server and skips cleanly, naming the
variable, unless `FINANCE_ARCHIVE_DATABASE_URL` points at a throwaway
database. Each run works inside a schema it creates and drops, so pointing it
at a shared development database cannot clobber anything.

The tradeoff, stated plainly: a public clone with no database still runs the
full suite and proves everything provable without a server, but exact
`NUMERIC` aggregation and the schema's own constraints are only exercised
where a database is configured, so CI has to configure one. The alternative,
requiring a container to run the suite at all, would make a clone's `pnpm
test:once` depend on Docker, which is a worse default for a repository whose
rule is that a public clone runs the full suite with no credentials.

## Schema and migrations (SQLite)

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

The suite creates its SQLite databases in a temp directory and removes them. A
public clone runs it with no credentials and no private files; the Postgres
integration tests skip unless `FINANCE_ARCHIVE_DATABASE_URL` is set (see
"Running the Postgres tests" above).
