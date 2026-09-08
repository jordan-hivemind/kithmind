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

The reconciliation gate (F1-4) is not implemented here; `reconciliations_passed`
and `reconciliations_failed` are always written as 0 by this importer.

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

## Checks

```
pnpm --filter @repo/finance-archive build
pnpm --filter @repo/finance-archive test:once
```

The suite creates its databases in a temp directory and removes them. A public
clone runs it with no credentials and no private files.
