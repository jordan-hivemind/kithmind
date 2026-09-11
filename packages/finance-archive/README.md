# @repo/finance-archive

The store, schema, migrations and money policy for the financial archive
described in
[`docs/plans/2026-09-07-financial-transaction-database.md`](../../docs/plans/2026-09-07-financial-transaction-database.md).

This package owns the store and the rules for what a number means inside it.
The adapter interface, importer, reconciliation gate and MCP server build on
top of it.

The archive is moving from a local SQLite file to hosted Postgres, so an
always-on machine and a laptop can share one archive. F1-20 added the Postgres
schema and the money representation it uses. **F1-22 moved the write path
onto it: the importer, both reconciliation gates and the adapter-to-importer
seam are Postgres, `async`, and speak decimals rather than minor units.**

SQLite has not gone away yet, and the reason is scope rather than nostalgia.
The read-only MCP server (F1-6) still reads a SQLite file, and its replacement
(F1-21) is on hold pending the shared typed contract, so `src/schema.ts` and
`src/mcp` stay exactly as they were, along with the seventeen attack tests
that are the specification the new read surface has to satisfy. The raw-tree
writer (`src/rawTree.ts` and the persistence half of `src/adapterImport.ts`)
also still takes a SQLite handle: F1-24 owns that path and is separating byte
identity from capture provenance in it concurrently. Both are marked below.

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
| Non-finite values are refused, all three Postgres ones   | `toNumericText`, `fromNumericText`, and the `finance_numeric` domain |
| Money crosses driver, JSON and MCP boundaries as text    | `ARCHIVE_TYPES` (`src/pgStore.ts`)                                   |

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
`ARCHIVE_TYPES` pins `NUMERIC`, `INT8` and `DATE` per connection rather than
process-wide, and `test/pgMoney.test.mjs` asserts both the pin and that the
process-wide parsers were left alone, with no database required. See "Driver
decoding is pinned per connection" below.

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

## Money and rounding policy (SQLite read surface)

This is the split representation SQLite forced, and it now describes only the
SQLite file the read surface still reads. The write path stores decimals; see
"Money on Postgres" above. Everything in this section about canonical form,
no-rounding-on-ingest and currency is policy rather than storage, and carries
over unchanged.

Money had two representations, and which one a column used followed one rule:
**amounts get summed, prices do not.**

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

`rowHashV2` is the deduplication contract on Postgres, and `contentKeyV2` is
the key the occurrence ordinal is counted over. They are always used as a
pair: the ordinal is counted with the key and then hashed into the hash, so a
key and a hash disagreeing about what "the same content" means would assign
ordinals against one partition and hash them against another, and
deduplication would break with nothing to see. `test/pgMoney.test.mjs` asserts
that they partition a synthetic row set identically, and that the v1 pair
partitions it the same way, which is what makes the identities the archive
deduplicates on the same set before and after the representation change.

`rowHash` (v1) is described below and is what the SQLite read surface's rows
carry. It hashes over account, process date,
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

## Publication

The plan is explicit that hosting the ledger coordinates nothing by itself:

> single writer by convention is not a publication boundary. A laptop querying
> mid-import must not see half a ledger, and must never see new transactions
> against an old reconciliation verdict.

Two shapes satisfy that. Readers could select an immutable completed dataset
revision, or an import could publish atomically. **Atomic publication was
chosen**, because it needs no revision column, no reader-side protocol and no
schema change: Postgres already hands a reader outside the transaction a
consistent snapshot, so one transaction spanning the import and both gates is
the entire mechanism. A dataset revision would add a column, a selection rule
and a retention question, and would buy something the archive does not yet
need, which is readers pinned to an old revision on purpose.

Three pieces implement it, all in `src/pgStore.ts`:

| Piece                    | What it does                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withArchiveTransaction` | Runs a body in one transaction, and **nests**: an inner call on a client already inside one joins it. That is what lets the import and both gates each be atomic alone and atomic together, with no caller left to remember a rule. |
| `lockArchiveForWrite`    | A transaction-scoped advisory lock every writer takes. A second import waits rather than racing, and is released by `COMMIT` or `ROLLBACK`, so it cannot leak past a crashed run.                                                   |
| `publishImport`          | Import plus both gates inside one of those transactions. The rows and the verdicts that judge them become visible in the same instant.                                                                                              |

Retries stay idempotent: a document already imported contributes nothing on a
second run, so the import that waited for the lock finds nothing left to do
instead of colliding on `row_hash` or `documents.sha256`.

`test/pgPublication.test.mjs` proves all of it from a **second connection**,
which is the only vantage point where the claim means anything -- a reader on
the importing connection sees that connection's own uncommitted work however
the code is arranged. It samples an in-flight import and finds only the
before-state or the after-state and never a partial ledger; samples the
transaction count and the period's verdict in one statement across a
publication that flips a passing period to failing, and finds only `1/pass` or
`2/fail`; shows a publication that trips ground rule 7 partway leaves no rows,
no document and no import run; and blocks a publisher behind a held lock,
waiting on `pg_locks` rather than on a sleep, to show the exclusion is the
database's and not a convention.

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

| Declaration      | For                                                     | Behavior                                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `json_allowlist` | A JSON payload (`structured_api`)                       | Named leaf paths are retained. `*` matches any array index or object key. Everything else is dropped. |
| `opaque`         | `pdf_statement`, `trade_confirmation`, `tabular_export` | Bytes retained whole, with a required stated reason. Refused outright for `structured_api`.           |

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

`publishImport(client, batch, now?)` is the entry point. It imports the batch
and runs both reconciliation gates over what it imported, as one atomic
publication, and returns counts: never row content (see "Working on the
archive without reading it" in the plan). See "Publication" below for why the
gates are not a separate step.

`importBatch(client, batch, now?)` underneath it turns normalized rows into
`documents`, `transactions` and `review_items`, and writes one `import_runs`
summary. It is still exported for an import a caller will gate separately, and
is still atomic on its own. Both are `async` and take a `pg` client.

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

`runReconciliationGate(client, importRunId?)` (`src/reconciliation.ts`) is ground
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

`runPositionReconciliationGate(client, importRunId?)`
(`src/positionReconciliation.ts`) is the validation half of holdings and the
position-side analogue of the cash gate. `publishImport` runs it against the
same `import_runs` row the cash gate used; run them by hand only when
re-gating after a correction:

```ts
const cash = await runReconciliationGate(client, runId);
const positions = await runPositionReconciliationGate(client, runId);
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
`instrument_id` column on `reconciliations`. Under SQLite there were two
reasons: a cash change was `INTEGER` minor units and a quantity change was
canonical decimal `TEXT`, and the storage-class `CHECK` constraints were per
column. On Postgres both are `NUMERIC`, so that reason is gone. What remains
is not stylistic. `reconciliations.currency` is `NOT NULL` and meaningless for
a share count. And a cash verdict and a position verdict must stay
distinguishable: with one table, every existing `SELECT ... FROM
reconciliations WHERE status != 'pass'` would silently start returning
per-instrument rows and every account's period list would multiply by its
instrument count. Two tables make the distinction the table name, which no
query can miss.

## Wiring an adapter to the importer

`src/adapterImport.ts` is the seam between `ParsedRow` (what an adapter's
`parse()` returns) and `ImportRow`/`ImportDocument` (what `importBatch`
consumes); neither the adapter interface nor the importer owns this mapping
on its own. `adapterPullToImportDocuments(client, pull)` does two things a
caller cannot do by combining the other two files alone:

- **Instrument resolution.** `ParsedRow.instrument` is a descriptor (symbol,
  cusip, isin, name); `resolveInstrumentId` turns it into a stable
  `instruments.id`, creating the row the first time it is seen. Precedence:
  `cusip`, then `isin`, then `symbol` and `name` together, then `symbol`
  alone, then a new row. A real identifier never merges two different
  instruments that happen to share a ticker. A bare symbol with no cusip,
  isin or matching name resolves to the _existing_ instrument with that
  symbol (the first one created for it, ordered by `ctid`, which for this
  insert-only table is insertion order)
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
  `importBatch` will (via `contentKeyV2` and `rowHashV2` in `rowHash.ts`,
  shared by both, always used as a pair, so they cannot drift apart) and compares the distinct-hash count against the
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

The persistence half of this file -- `persistAcquiredDocument` and
`recordRetainedTextPath`, under "Raw tree" below -- still takes a
`DatabaseSync`. F1-24 owns that path and is changing it concurrently, so F1-22
left it alone rather than porting the same lines twice. Until it lands, a
caller wiring an adapter end to end holds both handles, and
`test/adapterImport.test.mjs` says so where it does.

## Running an import

`src/run.ts` (`./run`, `pnpm --filter @repo/finance-archive import`, or
`node dist/run.js` after a build) is the operator command: one full
acquisition-to-verdict pass for one adapter, composed entirely from the
pieces above -- it adds no import, gate or publication logic of its own.

```
node dist/run.js \
  --adapter <path to a module exporting an InstitutionAdapter> \
  --session <path to a module whose default export builds an AdapterSession> \
  --selection <path to a JSON selection file> \
  [--now <ISO instant, for a reproducible run>] \
  [--dry-run]
```

`--adapter` is a module with a default export, or a named `adapter` export,
implementing `InstitutionAdapter`. `--session` is a module whose default
export is a function that builds an `AdapterSession` for this run -- a real
adapter's own browser bridge, kept out of this repository; the synthetic
adapter's suite wraps `createSyntheticSession` the same way (see
`test/run.test.mjs`). `--selection` is a JSON file naming what to acquire,
because discovery alone does not say which of what it finds an operator
wants pulled this run:

```json
{
  "institutionId": "<institutions.id, already provisioned>",
  "pulls": [
    {
      "accountId": "<accounts.id, already provisioned>",
      "docType": "activity_pull",
      "docDate": null,
      "selection": {
        "kind": "structured_api",
        "periodStart": "<yyyy-mm-dd>",
        "periodEnd": "<yyyy-mm-dd>"
      }
    }
  ]
}
```

A document-tier pull (`pdf_statement`, `trade_confirmation`) selects by
`{ "kind": ..., "externalId": "<id from a prior discover() call>" }` instead
of a period. Every `institutionId` and `accountId` named in the file must
already exist -- in both the raw tree's SQLite provenance file and the
Postgres archive -- before the run; provisioning an institution or account is
out of this command's scope.

The command runs `discover`, then `acquire`, `parse` and
`persistAcquiredDocument` for each pull, then wires every pull to
`ImportDocument`s with `adapterPullToImportDocuments` and hands the whole
batch to `publishImport` -- import, both gates and publication as the one
atomic step it already is. `--dry-run` runs the identical pass inside one
Postgres transaction and always rolls it back, so nothing commits; the raw
tree write still happens (content-addressed and idempotent, and structurally
required to produce a valid pull -- see "Wiring an adapter to the importer"
above), but "the database" a dry run never touches is the Postgres archive.

The summary is counts, sums and per-period verdicts, never a row: documents
acquired, bytes acquired, a sha256 standing for this run's whole acquisition
manifest, rows parsed, inserted, deduplicated and opened for review, exact
decimal money sums per currency computed by Postgres, and both gates'
verdicts per account (and, for the position gate, per instrument) and
period, each with its tolerance. No transaction row, description, payload or
account identifier beyond the adapter's own opaque ids is ever printed.

Every setting is the environment or a flag, with no default for any
connection string or path, mirroring `src/mcp/run.ts`:
`FINANCE_ARCHIVE_DATABASE_URL`, `FINANCE_ARCHIVE_RAW_TREE_ROOT`,
`FINANCE_ARCHIVE_SPACE_ID`, and `FINANCE_ARCHIVE_DB_PATH` (the local SQLite
file `persistAcquiredDocument` reads institution and account rows from --
see "Raw tree" below). `FINANCE_ARCHIVE_SCHEMA` is optional, defaulting to
`finance` as it does everywhere else in this package.

`test/run.test.mjs` runs the command against the synthetic adapter and a
throwaway Postgres, the same way every other Postgres-backed suite does, and
skips with the same message when `FINANCE_ARCHIVE_DATABASE_URL` is unset. It
asserts the summary's shape, that nothing in it looks like a row, and that a
second pass over the identical selection inserts nothing new.

## Raw tree

`acquire` (`src/adapter.ts`) returns bytes and a manifest; it does not write
anything to disk. `src/rawTree.ts` is where those bytes -- and any retained
extracted text -- are actually persisted, per ground rule 1: raw files are
immutable, written once, never edited, never deleted.

The managed root directory is configuration, read from
`FINANCE_ARCHIVE_RAW_TREE_ROOT` and nowhere else, the same pattern
`src/mcp/run.ts` uses for `FINANCE_ARCHIVE_READER_DATABASE_URL`: a missing setting is a
hard error naming exactly what is missing, never a default and never a
guessed location. No real path appears in this repository, in a fixture, or
in a test.

That managed root can be shared with a second subsystem writing under the
same directory (F1-28,
[`docs/plans/2026-09-08-unified-storage-assessment.md`](../../docs/plans/2026-09-08-unified-storage-assessment.md)'s
"one managed Dropbox root"), so `resolveRawTreeRoot` returns the configured
root joined with a fixed `archive/v1` layout-version segment, which is a
constant of this writer and never configuration, and a space id, which is
configuration: read from `FINANCE_ARCHIVE_SPACE_ID` and nowhere else,
following the exact same hard-error pattern. No real space id appears in
this repository, in a fixture, or in a test.

Layout is content-addressed:

```
<root>/archive/v1/<spaceId>/documents/<sha[0:2]>/<sha[2:4]>/<sha256>
<root>/archive/v1/<spaceId>/text/<sha[0:2]>/<sha[2:4]>/<sha256>.txt
<root>/archive/v1/<spaceId>/captures/<institutionSlug>/<yyyy>/<mm>/<captureId>-<manifestSha256>.json
```

Everything below the `archive/v1/<spaceId>/` prefix is unchanged: the write
functions (`writeRawDocument`, `writeRetainedText`, `writeCaptureManifest`)
take that already-scoped directory as their `root` argument and know nothing
about the prefix or where it came from -- `resolveRawTreeRoot` is the only
place that composes it.

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
the _document's_ content hash, next to the bytes it described. That is wrong
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
specific earlier attempt. Calling it twice with the _same_ `captureId` is a
retry of one attempt and is an idempotent no-op, exactly like a repeat
document write; calling it twice with _no_ `captureId` (or two different
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

`applyPgSchema(client)` creates the archive in its own named schema and
records the applied version in a `schema_version` table inside it. It started
as one initial schema rather than a translation of three SQLite migrations,
because there is no data behind those migrations and that is the whole reason
the engine changes now rather than later. The whole creation is one
transaction, an advisory lock keyed on the schema name excludes a second
creator by the database rather than by convention, and running it again is a
no-op returning the recorded version.

Anything after that first schema is an additive migration appended to
`PG_MIGRATIONS`, never an edit to the initial `CREATE`: once an archive
exists, the version table is the only thing that says what it already has.
`applyPgSchema` applies every migration whose version is above the recorded
one, in order, inside the same transaction and lock, and records each one.

| # | Migration                              | What it adds                                                                 |
| - | -------------------------------------- | ----------------------------------------------------------------------------- |
| 1 | initial postgres archive schema        | Every table, domain and index below.                                           |
| 2 | documents retained byte provenance     | `documents.retained_sha256`, `retained_byte_length`, `media_type`, `capture_id`. |

Migration 2 (F1-29,
[`docs/plans/2026-09-11-structured-evidence.md`](../../docs/plans/2026-09-11-structured-evidence.md))
names the immutable retained bytes a document's rows were parsed from, so a
citation can be checked against those bytes rather than trusted. All four
columns are nullable, there is no backfill, and a CHECK makes them
all-or-nothing: a document imported before this migration honestly says it
names no retained bytes and produces no evidence, while three of four would
be a provenance record that reads as complete and resolves to nothing.
`retained_sha256` is deliberately **not** `documents.sha256` and not unique.
For a single acquired file the two are equal, but a paginated pull is captured
as one immutable file and split into one `documents` row per page, and a page
row's `sha256` is a derived row identity naming no bytes; every page row of
one pull shares the same retained object. `media_type` is the adapter's own
declaration on `AcquisitionManifestEntry`, never inferred from the capability
tier -- a `pdf_statement` tier does not make the bytes a PDF, and the
synthetic fixture's statement bytes are UTF-8 text.

### Which schema, and why it is not `search_path`

Archive objects live in the schema named by `FINANCE_ARCHIVE_SCHEMA`,
defaulting to `finance`, and never in whatever the connection's `search_path`
happens to be. Co-locating databases is the plan of record, so a neighbouring
component's `schema_version` could otherwise answer for the archive's, and
`applyPgSchema` would conclude the schema was already current against a
database that does not have it. `pgSchemaVersion` reads a schema-qualified
table for exactly that reason.

Pinning the path is done twice, because once is not enough on the archive's
default endpoint:

| Where                                        | Mechanism                                        |
| -------------------------------------------- | ------------------------------------------------ |
| `createArchiveClient` / `createArchivePool`  | `search_path` in the connection's startup packet |
| `applyPgSchema` and `withArchiveTransaction` | `SET LOCAL search_path`, inside the transaction  |

The archive's default endpoint is a **pooled** one, where a session-level
`SET` issued outside a transaction is unreliable: the pooler can hand the next
transaction a different backend and the path is gone. `SET LOCAL` inside the
transaction is the part a pooler cannot take away. Requiring a direct endpoint
instead would be a workaround for a defect rather than a fix, so it is not the
answer here. `test/pgSchema.test.mjs` proves both halves against a connection
whose ambient path is a neighbour's schema: a foreign `schema_version` holding
version 99 is not mistaken for the archive's, and a full write path lands in
the archive's tables while a decoy `documents` table earlier on the path stays
empty.

A schema name is interpolated into DDL and into `SET LOCAL search_path`, where
a bind parameter is not allowed, so it is validated as a plain lowercase
identifier rather than quoted. Anything else is a configuration error.

All twelve tables plus `position_reconciliations` survive, with every
constraint the SQLite schema expressed: currency on every money column,
`positions.valuation_basis` and `valuation_note`, `commitments` designed and
unpopulated, `source_document_id` and `source_locator` on every derived row,
`acct_last4` constrained to exactly four digits, `row_hash` unique, and stable
opaque text identities. Dates become `DATE`, timestamps `TIMESTAMPTZ` and
flags `BOOLEAN`, so the SQLite `GLOB` spelling checks are unnecessary. Two
domains carry the rules that repeat across columns: `finance_numeric` (every
money, quantity, price and rate column) and `currency_code`.

`finance_numeric` rejects all three of Postgres's non-finite `NUMERIC` values,
not just one. `NaN` has always existed; `Infinity` and `-Infinity` have been
accepted for `NUMERIC` since Postgres 14. An infinite balance is not a
rounding problem, it is a value that makes every aggregate over the column
meaningless. The comparison is subtle in both directions: `'NaN'::numeric =
'NaN'::numeric` is true, unlike float `NaN`, so `VALUE = VALUE` would not
catch it, and `NaN` sorts above `Infinity`, so a range test would depend on
remembering that. Listing the three values under `=` needs neither fact.
Application-side validation in `pgNumeric.ts` refuses the same spellings on
the way in, but the domain is what makes it a database invariant, so the tests
insert each one as a server-side literal and assert the insert fails.

`position_reconciliations` keeps its own table. Under SQLite it was separated
partly by storage class, and that reason is gone. The other reason is not: a
cash verdict and a position verdict must stay distinguishable, or every query
for unverified periods silently starts returning per-instrument rows.

The connection string is read from `FINANCE_ARCHIVE_DATABASE_URL` and nowhere
else, the same rule `FINANCE_ARCHIVE_DB_PATH` and
`FINANCE_ARCHIVE_RAW_TREE_ROOT` already follow: a missing setting is a hard
error that names what is missing, never a default and never a guess.

### Driver decoding is pinned per connection

`NUMERIC`, `INT8` and `DATE` are pinned to arrive as text. The driver's
current defaults already do that for `NUMERIC` and `INT8`, which is exactly
why they are pinned rather than relied on: a default is a choice someone else
can change in a minor release. `DATE` is not a default -- the driver builds a
`Date` at local midnight, and reading the day back out of one lands on the
previous day west of UTC.

The pin is per connection, not per process. `pg.types.setTypeParser` is
module-global state shared by every `pg` consumer in the process, so a package
that sets it decides how other people's pools decode their own columns. That
was tolerable while this package was the only `pg` consumer and stops being
tolerable once pools are co-hosted. `ARCHIVE_TYPES` is handed to each archive
`Client` and `Pool` through node-postgres' own `types` config instead.
`test/pgMoney.test.mjs` asserts both halves with no database: that an archive
connection decodes the pinned OIDs as text, and that the process-wide parsers
were left alone.

### Running the Postgres tests

`test/pgMoney.test.mjs` needs no database and always runs: input validation,
driver decoding and the whole deduplication preimage are pure logic, and they
are the three places this port can go quietly wrong.
Every suite that touches the write path -- `pgSchema`, `importer`,
`reconciliation`, `positionReconciliation`, `adapterImport` and
`pgPublication` -- needs a real server and skips cleanly, naming the variable,
unless `FINANCE_ARCHIVE_DATABASE_URL` points at a throwaway database. So do
`pgReaderRole` and `pgReadSurface`, which additionally need that connection to
be able to `CREATE ROLE` and to revoke `PUBLIC`'s grants on the database: they
create a throwaway reader per test schema and drop it afterwards. Point them
at a container, never at the hosted archive. Each
test works inside a schema it creates and drops (`test/helpers/pgArchive.mjs`),
so pointing them at a shared development database cannot clobber anything, and
two tests can never see each other's rows.

`turbo.json` lists `FINANCE_ARCHIVE_DATABASE_URL` in this package's
`test:once` `passThroughEnv`. Without that entry turbo strips the variable and
every Postgres test skips, which looks exactly like a green run: CI would have
reported success while proving none of it.

Set `FINANCE_ARCHIVE_REQUIRE_DATABASE=1` where a skip is the failure. It makes
`test/helpers/pgArchive.mjs` throw on load when no URL is set, so every suite
that needs a database fails instead of skipping. CI sets it beside the URL. It
replaces an earlier CI step that grepped turbo's console output for a skipped
count: that assertion took three corrections to get right, first matching
nothing and then matching the word "skipped" inside a test name, and an
assertion that silently stops asserting is worse than none. The guarantee
belongs in the tests. Locally, with neither variable set, skipping is still
the behaviour, because a public clone runs the suite with no credentials.

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

## Read surface (F1-21)

`src/mcp` is the v1 assistant access surface: the six operations
[`@repo/finance-contract`](../finance-contract) defines, served over
[MCP](https://modelcontextprotocol.io) against the hosted archive, connecting
as a non-owner reader role. Run it with
`pnpm --filter @repo/finance-archive mcp` after a build.

`FINANCE_ARCHIVE_READER_DATABASE_URL`, `FINANCE_ARCHIVE_PRINCIPAL_ID` and
`FINANCE_ARCHIVE_SPACE_ID` are read from the environment and nowhere else,
with no default for any of them. The reader's connection string is
deliberately a different variable from the importer's
`FINANCE_ARCHIVE_DATABASE_URL`: one is the owner's credential and one is the
reader's, and the whole point of this task is that they are not the same.

`serveFinanceRead(client, request, spaceId)` is the archive side on its own,
without MCP. It takes a parsed contract request, returns a contract response,
and runs that response back through the contract's own parser before returning
it. The gateway that authenticates a caller belongs to the other workstream;
this is what it calls.

There is no `run_query` and no `describe_schema`. The plan's
typed-bounded-query waiver was retired, and a scoped gateway pointed at a SQL
surface does not satisfy the rule it was retired for. No caller-supplied SQL
reaches the database at all, so injection, multi-statement submission and
comment smuggling have no entry point rather than a defence.

### What the archive cannot serve yet

The contract requires at least one `retained_text_span_v1` evidence item on
every transaction, holding and balance record: a character span inside a
retained text blob, with `start`, `end`, `quote` and `quoteSha256` in Unicode
code points, plus the text's own hash, byte length and codepoint length, the
retained object's byte length and media type, and capture and revision
identity.

The archive has none of that. `source_locator` holds a `FieldLocator` -- a
capability tier, a row index or page number, a column label -- and a row index
is not a character offset. `documents` carries no byte length and no media
type. Capture and revision identity live in the raw tree's capture manifests
on the always-on machine's filesystem, which the read surface does not have.

So `list_transactions`, `list_holdings` and `list_balances` **withhold every
row** rather than fabricating a citation to fill the shape, and every response
that withholds one says so: `coverage.reasons` carries
`retained_evidence_unavailable` and `completeness` is `partial`. `truncated`
still reports that rows matched, so "there is something here you cannot cite
yet" stays distinguishable from "nothing happened". `aggregate_money` and
`get_coverage` need no evidence and are fully served.

Closing this needs character-offset locators from the parsers, retained byte
length and media type on `documents`, and capture and revision identity
reachable from the database. `retainedTextSpanEvidence` in `src/mcp/pgRead.ts`
is where they get assembled when they exist.

### Completeness, truncation and coverage

Every response carries `datasetRevision` and an explicit `completeness`. All
of one response's queries run inside one `REPEATABLE READ`, `READ ONLY`
transaction, so the revision is the snapshot every number in it was computed
from: a laptop querying mid-import sees one settled dataset, never half a
ledger. The revision is derived from the archive's own content, so two reads
of an unchanged archive report the same one and `expectedDatasetRevision`
pinning works.

A truncated page is marked `truncated` and carries a `nextCursor`. It is never
silently short.

**Zero rows with unknown coverage means no indexed match, not proof that no
event occurred.** Every list and aggregate call computes coverage for its own
filters, not only `get_coverage`, precisely so an empty page over an
unacquired range cannot come back against `complete` coverage.

`get_coverage` keeps apart three states that must never collapse:

| State                                     | `status`   | Gap code         |
| ----------------------------------------- | ---------- | ---------------- |
| Nothing ever acquired for this source     | `unknown`  | `source_gap`     |
| A period no reconciliation verdict covers | `unknown`  | `source_gap`     |
| A period whose gate has not passed        | `partial`  | `pending_import` |
| A period that passed but is under review  | `partial`  | `failed_import`  |
| A period that passed with nothing open    | `complete` | none             |

`unknown` is reserved for "nothing in the archive vouches for this range",
which is the state a caller must never read as absence.

Money crosses the wire as decimal strings and never as a JavaScript number,
`NUMERIC` decoding is pinned per connection, and every aggregate groups by
currency, so no request shape sums two currencies into one number. A value
past the contract's 38 significant digits or 18 fractional places is withheld
with `unsupported_value`, never rounded and never silently omitted.

## The reader role (F1-21)

`applyPgReaderRole(client, { password })` in `src/pgReaderRole.ts` is the whole
setup path: code that is run and tested, not instructions someone follows by
hand once. It is idempotent, and re-running it is the documented step after a
migration adds a table.

"A role with `SELECT`" is not a privilege state. Postgres grants `CONNECT` and
`TEMPORARY` on a database and `EXECUTE` on functions to `PUBLIC` by default,
privileges reach a role through membership, and default privileges decide what
a later table is born with. So:

| Concern             | What the setup does                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Ownership           | A non-owner role that owns nothing, so it cannot alter what it reads                              |
| Attributes          | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`                         |
| Membership          | Asserted empty; `NOINHERIT` does not stop `SET ROLE`, so a membership is an error, not a warning  |
| Database            | `REVOKE ALL ... FROM PUBLIC`, then `GRANT CONNECT` only. `TEMPORARY` is never granted back        |
| Schema `public`     | `REVOKE ALL ... FROM PUBLIC`, so the reader cannot reach a co-located component's tables          |
| Archive schema      | `USAGE` only, never `CREATE`                                                                      |
| Tables              | `REVOKE ALL` from `PUBLIC` and from the reader, then `GRANT SELECT`                               |
| Sequences, routines | `REVOKE ALL` from `PUBLIC` and from the reader                                                    |
| Domains             | `REVOKE ALL` from `PUBLIC`, then `GRANT USAGE` to the reader, which needs it to read the columns  |
| Default privileges  | Revocations only. **No** default `SELECT` grant, so a later table is not silently readable        |
| Statement time      | `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` on the role         |
| Transaction mode    | `default_transaction_read_only = on`, plus an explicit `READ ONLY` transaction per response       |
| Rows                | Every generated statement carries its own `LIMIT`; the contract caps a page at 100                |
| Concurrency         | `CONNECTION LIMIT`, enforced at connection time and not settable from inside a session            |

`SUPERUSER`, `BYPASSRLS` and `REPLICATION` are stated once, in `CREATE ROLE`.
Postgres lets a non-superuser mention them there -- only setting them true is
gated -- but refuses the mention in `ALTER ROLE`, even when it names the value
the role already has. The hosted owner has `CREATEROLE` and `CREATEDB` and is
not a superuser, so the re-run path reads those attributes back from
`pg_roles` and refuses a role that does not already satisfy the boundary
rather than issuing a statement the owner cannot run (F1-30).

The role's `statement_timeout` is a setting the role can raise, so it is
deliberately not the only control. `CONNECTION LIMIT` cannot be raised from
inside a session, which needs `CREATEROLE`; the `LIMIT` is in the SQL the
surface generates; and there is no caller-supplied statement for a raised
timeout to run.

Revoking `PUBLIC`'s `USAGE` on schema `public` is a database-wide change and
it is deliberate. A privilege held via `PUBLIC` cannot be revoked from one
role, so keeping the reader out of `public` means `PUBLIC`'s own grant has to
go. A co-located component gets an explicit grant rather than inheriting one.

One measured limitation, asserted in both directions in the tests so it cannot
rot into a false claim: `ALTER DEFAULT PRIVILEGES ... REVOKE ... ON FUNCTIONS
FROM PUBLIC` **does not take effect**. Postgres stores a default-privilege
entry as a delta over the built-in default and merges the two at creation
time, so a function created later still carries `PUBLIC`'s `EXECUTE`. The
concrete revoke on a re-run is what removes it. Default privileges do work for
tables and sequences, which is where the "a later migration must not be
silently readable" requirement bites.

### The attack tests

`test/pgReaderRole.test.mjs` re-expresses each of the seventeen SQLite attacks
as its Postgres equivalent and asserts refusal against a real server. The
setup under them runs as a non-superuser role with `CREATEROLE` and
`CREATEDB` that owns its own throwaway database, which is what the hosted
owner is; running it as a superuser hid F1-30. The
mapping is in a table at the top of that file. Confirming that a `PRAGMA` is a
syntax error on Postgres would prove nothing, so none of these do that. They
test writes and DDL under the reader role, `COPY` to and from a file and to a
program, large object functions, `pg_read_file` and friends, `dblink` and
`postgres_fdw` as the `ATTACH` analogue, `ALTER SYSTEM` and
`session_replication_role` as the mutating-`PRAGMA` analogue, reading another
schema and `pg_authid` as the reading-`PRAGMA` analogue, `CREATE EXTENSION` as
the `load_extension` analogue, multi-statement submission through the simple
query protocol, a write hidden in a CTE, and `SET ROLE` escalation.

Every write is asserted refused twice: once under the role's read-only default
(`read_only_sql_transaction`), and again with that default turned off, where
the refusal has to come from `insufficient_privilege`. Testing only the first
would test the softest layer and call it a boundary.

## Provisioning a live database

`scripts/provision.mjs` applies `applyPgSchema` and `applyPgReaderRole` (both
idempotent) to whatever database `FINANCE_ARCHIVE_DATABASE_URL` points at.
Run it against a throwaway database first, never a hosted one first:

```
FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
  node scripts/provision.mjs
```

It requires a build (`pnpm --filter @repo/finance-archive build`) first,
since it imports `dist/`. It prints the schema name, the table count, the
reader role name, whether the reader has `CREATE` on the schema (must be
`false`) and `TEMPORARY` on the database (must be `false`), and the reader's
connection string -- generated fresh on every run and printed exactly once,
never written to a file by this script and never logged again. Store it
yourself; re-running the script rotates the reader's password.

## Checks

```
pnpm --filter @repo/finance-archive build
pnpm --filter @repo/finance-archive test:once
```

The suite creates its SQLite databases in a temp directory and removes them. A
public clone runs it with no credentials and no private files; the Postgres
integration tests skip unless `FINANCE_ARCHIVE_DATABASE_URL` is set (see
"Running the Postgres tests" above).
