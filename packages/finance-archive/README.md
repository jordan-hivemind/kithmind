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
activity type, description, quantity and amount, using canonical forms, with the
currency included because an amount in minor units has no meaning without the
scale its currency gives it. Activity type is lowercased and whitespace inside
descriptions is collapsed, since PDF extraction varies the gaps between runs. A
provider transaction ID is preferred where one exists and is stable; the hash is
the fallback. `transactions.row_hash` is `UNIQUE`.

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
