# Shared finance read contract

Status: implemented as a shared proof contract, tracked as P2-39. Gateway and
storage adapter integration remain separate work.

Finance needs one read boundary that can be implemented against either the
current store or a relational proof without changing the meaning of amounts,
identity, provenance, or completeness. The first version is intentionally small.
It supports the read paths needed to compare implementations. It does not expose
arbitrary SQL or define a general financial schema.

The `@repo/finance-contract` package contains dependency-light TypeScript types,
closed runtime validators, and synthetic fixtures. It does not authorize database
access by itself.

## Operations

| Operation           | Result                                                     |
| ------------------- | ---------------------------------------------------------- |
| `list_transactions` | Transaction records with money and retained evidence       |
| `list_holdings`     | Positions at a date with quantity and optional valuations  |
| `list_balances`     | Account totals and optional cash balances                  |
| `aggregate_money`   | Currency-safe totals with auditable contributors           |
| `get_evidence`      | Retained source and indexed text references for one record |
| `get_coverage`      | Explicit source, record-kind, and date coverage            |

Every request has contract version 1, a space ID, a limit from 1 through 100,
and an optional opaque cursor. Operation-specific filters are closed. Unknown
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
- Synthetic exchanges cover all six operations through the authorized paired
  validator.
- Tests cover closed requests, trusted space authorization, pagination and
  revision binding, completeness invariants, evidence path and quote integrity,
  aggregate contributor auditability, precision overflow evidence, and the
  response-size bound.
- The package builds and tests independently without a database or personal data.
- Store-specific adapters and the cross-store parity proof must use this contract
  before any production finance migration or publication switch.
