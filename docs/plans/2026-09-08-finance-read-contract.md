# Shared finance read contract

Status: implemented in the shared contract, PostgreSQL reader, and scoped web
gateway. Deployment verification remains the F1-73 acceptance checkpoint.

Finance needs one read boundary that can be implemented against either the
current store or a relational proof without changing the meaning of amounts,
identity, provenance, or completeness. The first version is intentionally small.
It supports the read paths needed to compare implementations. It does not expose
arbitrary SQL or define a general financial schema.

The `@repo/finance-contract` package contains dependency-light TypeScript types,
closed runtime validators, and synthetic fixtures. It does not authorize database
access by itself.

## First-use-case priority: usable dated holdings queries

Owner priority, 2026-09-13. Financial-services queries are the first user use
case. Deliver this finance-archive capability before advancing to the remaining
general PostgreSQL feature milestones. Preserve in-flight query and coverage
work, but its completion alone does not satisfy this first-use-case acceptance.
This section defines the deployed-read acceptance, not a claim that deployment
verification has already passed.

A fresh agent must be able to resolve an account by institution, last four digits
and display label, then retrieve one dated holdings snapshot with meaningful
instrument identities. For public tests, use a synthetic request such as:
“Give me the July 31, 2026 holdings for Example Broker account ending 1234,
Income: instrument name or ticker, quantity, market value, cost basis,
unrealized gain or loss, account totals, and the dataset revision.”

Required behavior:

- Expose authorized account discovery and instrument identity, through bounded
  lookup operations or enriched responses. Retain stable opaque IDs alongside
  institution, account label and last four digits, instrument name and symbol
  when known. Never expose full account numbers or guess missing identities.
  Ambiguous account matches require disambiguation.
- Document the existing `accountId` and `asOf` filters in the agent-facing tool
  schema and examples. The current implementation treats `asOf` as an upper
  bound and can return historical snapshots oldest first. Define and implement
  explicit exact-date and latest-eligible-snapshot selection; do not sum multiple
  statement dates or silently substitute another date when an exact date is
  requested. Missing snapshots must be reported clearly.
- Return all positions in the selected snapshot through server-issued bounded
  pagination. Bind continuation to authorization, account, snapshot selection,
  normalized filters and dataset revision. An agent must not need to manufacture
  a cursor or page through unrelated years to reach the requested snapshot.
- Preserve quantity, market value, cost basis, valuation basis and retained
  evidence. Provide an auditable path to exact unrealized gain/loss and account
  totals by currency. Use canonical decimal arithmetic, disclose missing values
  and incomplete coverage, and reconcile position-derived totals with stated
  account totals when both are available. Do not convert missing cost basis to
  zero or combine different currencies.
- Update the shared contract, validators, finance reader and MCP descriptions
  together. Coordinate contract changes through Issue 57 and define compatibility
  for existing clients instead of silently changing version 1 behavior.

Acceptance is an end-to-end query through the deployed scoped finance gateway
from a fresh agent with only the advertised tools and documentation. It resolves
an unambiguous synthetic account, selects exactly the requested snapshot,
returns named positions in a spreadsheet-ready table with per-currency totals,
citations and dataset revision, and traverses a multi-page snapshot without
omissions or duplicates. Tests also cover ambiguous/missing identities, absent
snapshot dates, withheld evidence, missing cost basis, revision changes and
cross-space or revoked-access denial. Owner verification uses a privately
specified real holdings request; no personal account data enters public fixtures.
PostgreSQL consolidation alone must not be recorded as closing this usability gap.

### Inventory snapshot dates and valuation meaning

`list_account_inventory.latestSnapshotAsOf` reports the latest complete dated
holdings observation. Every position at that date must have a value and an
explicit valuation basis of either `market_price` or `reported_nav`; an exact
source-stated zero is also a dated observation. The normal source, review and
reconciliation gates still apply. Currency does not change whether an
observation exists, so positions at the date may span currencies.

This date does not turn every stated value into a market value. A
`reported_nav` position can establish snapshot freshness, but inventory
`currentValue` remains limited to a complete one-currency `market_price`
snapshot. When the latest eligible snapshot is NAV, an older market snapshot
must not reappear as current. `get_holdings_snapshot` selection and
`aggregate_money` retain their existing, stricter valuation and aggregation
semantics.

## Operations

| Operation               | Result                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `list_accounts`         | Authorized account discovery and disambiguation            |
| `get_holdings_snapshot` | One exact or latest eligible named holdings snapshot       |
| `list_transactions`     | Transaction records with money and retained evidence       |
| `list_holdings`         | Positions at a date with quantity and optional valuations  |
| `list_balances`         | Account totals and optional cash balances                  |
| `aggregate_money`       | Currency-safe totals with auditable contributors           |
| `get_evidence`          | Retained source and indexed text references for one record |
| `get_coverage`          | Explicit source, record-kind, and date coverage            |

Every request has contract version 1, a space ID, a limit from 1 through 100,
an optional opaque cursor, and an optional expected dataset revision.
Operation-specific filters are closed. Unknown
fields, sparse arrays, invalid dates, unsupported currencies, and malformed
cursors fail validation.

A request contains the target space but never a caller identity or role. The
gateway constructs the principal and authorized-space set from trusted
authentication state. It must not deserialize this context from an HTTP request
body. `parseAuthorizedFinanceReadExchange` checks that authorization and binds
the response to the request's operation, space, requested limit, directly
represented filters, and an optional expected dataset revision. Evidence responses
also echo the requested record ID. A source filter requires at least one retained
evidence reference from that source; a record may also cite supporting sources.

`parseFinanceReadResponseShape` is a lower-level structural validator. Calling it
alone does not establish authorization, database coverage, or that the selected
records satisfy the request filters. Normalized requests are also capped at 16
KiB.

Server-issued cursors must bind the authenticated principal, space, exact
normalized operation and filters, dataset revision, and expiry. An aggregate
breakdown cursor must also bind its query reference. Those server-side bindings
cannot be proven from an opaque cursor's wire shape.

## Decimal and currency rules

Wire amounts and quantities are canonical decimal strings. JavaScript numbers,
exponents, leading plus signs, leading integer zeroes, trailing fractional zeroes,
and negative zero are rejected. The separate normalization function converts
equivalent accepted input spellings, including negative zero to `0`, before a
producer writes a wire value. Precision is limited to 38 significant digits and
18 fractional digits after normalization, matching the Phase 1 archive policy.

Version 1 accepts only the shared Phase 1 currency registry: AUD, CAD, CHF, CNY,
EUR, GBP, HKD, INR, JPY, KRW, MXN, NZD, SEK, SGD, and USD. Aggregate result
currency must equal the total's currency. Producers must reject unsupported
precision instead of rounding. A `precision_overflow` issue retains the exact
canonical source text, measured digit counts, field, record ID, and evidence.

## Identity and evidence

Space, source, document, revision, capture, record, account, instrument, and
dataset revision IDs are bounded opaque identifiers. They are stable references,
not byte hashes. The finance archive owns its row identity and canonical hash
version 2 mapping. This package deliberately does not invent or reimplement that
algorithm.

A retained text-span evidence item separates two identities:

- `sourceObject` identifies the retained source bytes through source, document,
  revision, and capture IDs plus SHA-256, byte length, and media type.
- `locator` identifies a retained UTF-8 text artifact by a bounded relative
  archive path, SHA-256, byte length, and Unicode code point length. Its start and
  end offsets use the explicit `unicode_code_points` unit. It includes a bounded
  indexed quote and the validator recomputes the quote's SHA-256.

A PDF byte offset is never represented as a text offset. The storage adapter must
verify the text artifact hash and length and must verify that the indexed code
point slice equals the quote before publishing the response. The structural
validator checks bounds, unique evidence IDs within each evidence list, quote
length, quote hash, and basic byte-length plausibility. Relative locators follow the retained archive namespace and cannot
contain absolute paths, traversal segments, control characters, credentials, or
provider paths.

The public synthetic fixture uses placeholder retained-object and text-artifact
hashes to exercise structure. Its quote hash is real. It is not evidence that an
archive object exists.

## Completeness and auditability

Every response identifies one dataset revision and has a maximum normalized
serialized size of 512 KiB. It carries a coverage summary, completeness flag,
truncation state, next cursor, and structured issues. A response can claim
`complete` only when coverage is complete, it is not truncated, it has no next
cursor, and it has no issues. A `partial` response must expose at least one reason,
issue, or continuation cursor. Coverage rows cannot claim complete when they
contain gaps.

Aggregate groups include the contributing record count and up to 25 unique
contributor record IDs. When the count exceeds the listed IDs, the group must
include an opaque query reference and continuation cursor bound to the response's
dataset revision. When every contributor is listed, a breakdown handle is
forbidden. A group with zero contributors must have a zero total. This makes a small total directly auditable and gives a bounded path
to inspect a larger total without placing every ID in one response.

The validator prevents wire-level false completeness and malformed aggregates.
The server remains responsible for proving that coverage records reflect the
stored source history, contributor IDs produce the stated total, cursors are
bound as specified, and returned records satisfy the authorized request. Aggregate
source, date, and account filters for currency-only grouping are not represented
on each result group, so the storage adapter must enforce them and bind them into
any breakdown cursor. A holdings `asOf` filter rejects future-dated results; the
server is responsible for choosing the latest eligible stored observation.

## Acceptance

- Canonical decimal normalization matches the archive's 38-digit and 18-scale
  policy. Noncanonical wire values, numeric inputs, exponents, and unsupported
  currencies fail closed.
- Synthetic exchanges cover all eight operations through the authorized paired
  validator.
- Tests cover closed requests, trusted space authorization, pagination and
  revision binding, completeness invariants, evidence path and quote integrity,
  aggregate contributor auditability, precision overflow evidence, and the
  response-size bound.
- The package builds and tests independently without a database or personal data.
- Store-specific adapters and the cross-store parity proof must use this contract
  before any production finance migration or publication switch.

## Update 2026-09-11: a second evidence kind

Evidence is now a union. `retained_text_span_v1` is unchanged.
`structured_field_v1` cites one scalar datum inside retained JSON or delimited
bytes, by JSON pointer or by row and column, with the exact retained token
bound by value and hash. `RetainedSourceObject` is shared by both kinds and
accepts `text/csv; charset=utf-8`. Every evidence list on a record, an issue,
and the `get_evidence` response is now `FinanceEvidence[]`, so a consumer must
discriminate on `kind` before reading a locator. See
[`2026-09-11-structured-evidence.md`](2026-09-11-structured-evidence.md) for
the type, the format rules, and the validator table.

## Update 2026-09-13: usable holdings snapshots

F1-73 adds two operations to contract version 1. This is an additive extension.
The original six operations retain their request and response meanings. In
particular, `list_holdings.asOf` remains an upper bound over historical rows and
does not become an exact-date selector. Existing unsigned cursors are invalidated
as a security correction.

`list_accounts` accepts normalized exact-match filters for institution name,
account last four, and display label. It returns opaque account and source IDs,
institution name, optional display label and account type, last four digits, and
base currency when the archive reports a supported currency. An account with a
missing or unsupported base currency remains discoverable by its opaque identity
and carries an explicit `not_reported` or `unsupported_value` disclosure. A
consumer must not guess a default currency. Its response reports `none`,
`unique`, or `ambiguous` against the whole authorized match set. An ambiguous
response is a prompt for disambiguation, not permission to select the first row.
Full account numbers are never stored or returned.

Account last four uses an evidence-learned `statement_number` alias when one is
available. The reader accepts only the statement parser's closed
`###-######-###` format and derives the last four from the central account
component. It never derives account digits from the unrelated timestamp-shaped
API key. If one account has verified aliases with different last-four values,
the descriptor reports `ambiguous_aliases`; a filtered result carries only the
four digits it matched so the gateway can bind the response to the request.
Collisions across accounts remain multiple matches. Full statement numbers do
not enter the response or logs.

`get_holdings_snapshot` requires an account ID and one closed selector:

- `{ "mode": "exact", "asOf": "YYYY-MM-DD" }` selects only that date.
- `{ "mode": "latest", "onOrBefore": "YYYY-MM-DD" }` selects the greatest
  eligible date. `onOrBefore` is optional.

The response echoes the requested selector and reports either the one selected
date or `not_found`. Every page is constrained to that selected date. Positions
carry stable record and account IDs, supported currency, and an instrument
identity state. A resolved or ambiguous instrument retains its opaque ID and
available name and symbol. A missing identity has no invented ID. Open weak
instrument-match review items produce `ambiguous`, not `resolved`.

Each stored quantity or money field is either returned with evidence scoped to
that field, or omitted with `not_reported`, `unsupported_value`, or
`retained_evidence_unavailable`. An uncited financial value is never returned as
usable data. Derived unrealized gain or loss is separately labeled with the
formula `market_value_minus_cost_basis`; the validator recomputes it exactly.
Stored unrealized gain or loss remains distinct when the source reports it.

The whole-snapshot summary is bounded to 10,000 positions and 8 MiB of stored
source-locator JSON. A page remains available when either summary bound is
exceeded, and the response reports which bound prevented the whole-snapshot
summary. Each page also reserves envelope space under the 512 KiB response
ceiling. The summary reports instrument
and quantity coverage and keeps market value, cost basis, stored unrealized, and
derived unrealized subtotals separate by currency. Every metric includes
contributing and missing counts. Aggregate precision overflow omits the amount
and reports the issue instead of rounding. Stated account totals cite their
balance record and evidence. Reconciliation uses the explicit formula
`stated_account_total_minus_position_market_value`, which the validator checks
with canonical decimal arithmetic. Missing or ambiguous totals and incomplete
position coverage cannot produce a final reconciliation.

All continuations are stateless HMAC-SHA256 tokens using a stable deployment
secret of at least 32 bytes. The signed binding covers the authenticated
principal, space, operation, normalized request and limit, dataset revision,
selected snapshot date, sort key, and expiry. The optional
`expectedDatasetRevision` may be added after page one without changing the query
binding. A changed revision fails with `revision_changed`; a malformed, expired,
replayed under another principal, or differently filtered cursor fails as an
invalid request. A client must discard accumulated pages and restart after
either failure.

Migration 11 adds a singleton revision epoch and monotonic counter. Triggers run
`BEFORE STATEMENT` for inserts, updates, deletes, and truncates on
every table used by the read surface, including retained evidence. The counter
update is transactional, so rollback restores the prior revision. Taking its row
lock before table row locks also gives concurrent writers one lock order. A
missing singleton fails the write rather than permitting an unrevisioned change.
The reader fetches the epoch and counter in O(1) inside the same repeatable-read
transaction as the response.

Migration 12 adds the same revision trigger to the existing `account_aliases`
table and advances the counter once while applying the migration. That one-time
advance invalidates continuations issued before aliases became an account-read
dependency. The table already exists, but a reader role provisioned before it
was created needs one targeted grant without credential rotation:

```
GRANT SELECT ON <schema>.account_aliases TO <schema>_reader;
```

Apply the migration with the owner connection in development first, then in the
approved target:

```
pnpm --filter @repo/finance-archive build
FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> pnpm --filter @repo/finance-archive migrate
```

An existing reader role does not automatically gain access to a table created by
a later migration. Grant only the new read needed by the revision query and keep
the trigger function unavailable to `PUBLIC`:

```
GRANT SELECT ON <schema>.finance_read_revision TO <schema>_reader;
REVOKE ALL ON FUNCTION <schema>.bump_finance_read_revision() FROM PUBLIC;
```

Do not rerun `scripts/provision.mjs` for this grant. That script calls
`applyPgReaderRole` with a newly generated password and rotates the credential
held by the gateway.

## Update 2026-09-18: institution-symbol instrument identity

F1-76 phase 3 adds one instrument identity state and one summary count to
contract version 1. This is an additive extension. Every existing operation,
request and response meaning is unchanged, and no existing field changes what
it reports.

The archive gains an instrument match tier between "symbol and name together"
and "symbol alone": the same-institution symbol rule. A symbol-only match is
accepted when the symbol names exactly one instrument in the archive, that
instrument carries a CUSIP or an ISIN, and only the institution that stated the
holding has rows referencing it. Anything the rule refuses stays an open
`weak_instrument_match` review item, and owner confirmation through the review
queue remains the fallback.

| Change                             | Where                              | Meaning                                                                                                                                  |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `institution_symbol`               | `FinanceSnapshotInstrument.status` | The instrument was matched on a ticker symbol alone and accepted under the rule. A usable identity, and not the same fact as `resolved`. |
| `institutionSymbolInstrumentCount` | `FinanceHoldingsSnapshotSummary`   | Positions in this snapshot whose identity rests on the rule. Required, and counted apart from both other totals.                         |

Compatibility rules for existing clients:

- A client that switches on `resolved`, `ambiguous` and `missing` now sees a
  fourth value and must not treat it as `ambiguous`. Citing such a position as
  identified by a CUSIP or ISIN is wrong; citing it as identified by the
  institution's own symbol is correct.
- `resolvedInstrumentCount` still counts only identifier matches.
  `unresolvedInstrumentCount` still counts open weak matches and missing
  instruments. The three counts sum to `positionCount`, which the validator
  enforces.
- An accepted match does not make a snapshot `partial` and does not add
  `unresolved_identity` to coverage. A withdrawn one does, immediately.
- `resolvedInstrumentCount + institutionSymbolInstrumentCount` is the old
  `resolvedInstrumentCount` for a client that only wants "identities I can
  use".

The rule's evidence is `instrument_identifier_sources`: one row per
(instrument, institution) whose parsed descriptor stated a cusip or isin. An
instrument no institution is on record for is refused, so an archive migrated
from before that table runs
`scripts/backfillInstrumentIdentifierSources.mjs --apply` once, before the
reparse, or every affected position keeps reporting `ambiguous`. That pass is a
dry run without `--apply`, counts only transactions carrying a provider
transaction id from an export-tier source document, and skips any instrument
two institutions qualify for.

The archive records each decision durably in `review_items`: an acceptance as a
`resolved` `institution_symbol_match` naming the rule, a refusal as an open
`weak_instrument_match` carrying a closed `reason_code` for the condition that
failed. A later import that makes an acceptance unsafe dismisses it and reopens
the weak item with `institution_symbol_match_invalidated`, so the read surface
reports `ambiguous` again with no position rewritten.

## Update 2026-09-21: account-scoped position correction

Migration 15 records versioned account/date position observations and their
exact semantic members. A read may use a complete observation only when its
retained SHA and generation match the document's active projection, its member
multiset exactly equals the canonical account/date rows, and every ordinary
review and reconciliation gate still passes. A source-wide
`document_unparsed` finding is ignored only for an account/date with that exact
positive proof. Null-account non-parser findings remain blocking.

Migration 16 lets the existing holding generation publisher replace explicitly
selected complete position scopes in a partially parsed consolidated document.
It retains all nonselected positions, balances and liabilities byte-for-byte,
keeps the document partial, and carries complete and partial nonselected scope
observations into the new generation without upgrading them. Exact rows owned
by another retained source may satisfy membership only when their full stored
semantics agree and this source supplies independent locator evidence. Their
canonical ownership never moves.

Every candidate and approval binds the retained SHA, prior active generation,
old and composed projections, selected canonical row identities and owners,
complete scope evidence, and explicit removal and empty-scope authority. A
positive source-stated zero can remove the last selected position. Old
assertions remain available to evidence lookups, while position reconciliation
is recomputed for instruments present in either the old or corrected selected
set. A scoped position correction replaces only position rows owned by the
selected source. It preserves unrelated foreign-owned positions even when that
source's complete proof does not name them. The immutable source proof remains
inexact, and reads stay blocked, until the other source corrections converge
on the same complete canonical set. If the candidate does name a foreign hash,
every stored semantic field must still match and ownership never moves. A stale
approval, cited foreign semantic mismatch or changed canonical set refuses the
entire transaction. Balance corrections retain their stricter whole-selected-
set foreign-row requirement.

Parser proof changes are also immutable projection changes. A parser replay
that would change an existing generation's proof payload refuses the replay by
design. The supported repair is to prepare, review and publish a new scoped or
whole-document generation bound to the retained bytes and exact prior state.
Operators do not loop ordinary reparses to try to mutate an active proof.

### Account/date attribution for reparse mismatches

Migration 17 records the actual account, date and projection kind affected by
a system-generated holding or activity projection mismatch. A scoped holding
mismatch blocks only that account/date in finance reads. An activity mismatch
is account scoped and retains its process date for audit, but holdings readers
continue to attribute it through the source document's actual holdings dates.
They do not treat the activity process date as a holdings valuation date.

Attribution is fail closed. A mismatch stays document-wide when any contributing
stored row, candidate row or conflicting foreign row lacks a valid account/date,
or when the mismatch cannot be tied to rows at all. Existing unscoped reviews
also remain document-wide. A reparse may supersede an open generic row only when
its exact reason proves the importer created it and every mismatch is attributed;
dismissed rows, manually resolved rows and unknown legacy reasons retain their
history and behavior. The scoped review rows carry independent identities so a
later reparse can resolve or reopen one account/date without rewriting another.

The generated note `Market Value|NAV column of the <SECTION> holdings table`
records two different things. The column label states the valuation basis; the
section label records where that source printed the row. Exact scope comparison
therefore permits different valid all-caps section labels only within that
closed generated grammar. It still requires the same column label and exact
dated-lot suffix, as well as equal quantity, price, value, cost, unrealized,
currency, row hash, account and date. Literal notes, nulls and disclaimers stay
exact. Each source's original note and locator remain immutable evidence; no
canonical row is rewritten or rehomed.
