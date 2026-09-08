# Historical financial transaction database

**Status:** Planned independent workstream. Added at the owner's request on
2026-09-07. It does not block the single-owner document-Q&A trial.

## Goal and ownership

Build a durable database of the owner's financial transactions, starting with
every historical statement and transaction export available from the selected
institutions. Provider examples include Morgan Stanley, Chase and Vanguard.
Track unavailable periods explicitly; available online history is not assumed
to equal the account's full lifetime.

A separate agent team can build acquisition, the database, reconciliation and
its query service in parallel. The Kith Mind team owns the integration adapter,
existing access-scope enforcement, coverage/freshness reporting and end-to-end
question tests. Do not duplicate the financial ingestion implementation inside
Kith Mind or make its completion a prerequisite for the current PDF trial.

Local storage is the initial preference, not an adopted database-engine choice.
Assess existing financial importers and ledger software before building another
one. Select an engine and reuse strategy against the actual history volume,
statement formats, exact numeric requirements, portability and backup needs.
Record the tradeoff; SQLite, for example, is a candidate rather than a presumed
best choice. The public implementation and synthetic fixtures should be usable
without owner credentials or private files.

## Independent team's deliverables

1. Inventory the selected institutions and accounts with opaque stable account
   IDs. Establish the history actually available from each portal, supported
   exports, statement formats, access requirements and acquisition limits.
   Download all available historical statements and complementary structured
   transaction exports through authorized access. Preserve an acquisition
   manifest with statement period, download time, content hash and gaps.
2. Retain original files in a recoverable encrypted archive. Prefer a supported
   structured export when it preserves transaction detail; retain statements
   as evidence and reconcile overlapping exports instead of importing both as
   separate transactions. Browser-assisted/manual export is acceptable when
   no suitable connector exists. Provider capabilities must be verified during
   implementation, not inferred from a provider name.
3. Normalize transactions into a versioned schema with source evidence. Keep
   original descriptions, transaction and posting/settlement dates, date
   precision, account, currency, exact signed amount and status. Preserve
   investment-specific activity, instrument identifiers, quantities, prices
   and fees without forcing every activity into a cash-spending row. Use exact
   decimal or integer representations; never binary floating-point money.
4. Reconcile repeated downloads, overlapping periods, pending-to-posted changes,
   reversals and corrected statements. Prefer provider transaction identifiers
   where trustworthy; otherwise use evidence-based identities and explicit
   ambiguity review. Equal date/amount/description is not proof of duplication.
   Transfers between owned accounts must not become spending twice; investment
   trades, distributions and reinvestments need explicit aggregation semantics.
5. Record coverage per account and period, including acquisition, parsing,
   reconciliation, uncertainty and any missing statements. Reconcile against
   statement totals/balances where the document permits it. A completed import
   job alone cannot establish complete transaction history.
6. Provide repeatable incremental updates, an inspectable error/review queue,
   correction history, deletion handling, backup and a verified restore. A new
   download must not erase a prior recoverable version before replacement is
   validated. Keep raw statements, credentials and real transactions out of
   the public repository; publish synthetic fixtures and reproducible setup.

## Integration contract to agree before parallel implementation

Use a small versioned read-only service boundary. The transport can change
without changing the transaction schema. The following are proposed operations
for agreement with the independent team:

| Operation                  | Required behavior                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List accounts              | Opaque stable IDs, institution label, account type, currency and authorized scope. No account secrets.                                                      |
| Query transactions         | Bounded filters for accounts, dates, amount/currency, activity type and description; deterministic pagination; explicit transaction/posting date semantics. |
| Aggregate transactions     | Exact sums and counts with currency separation, transfer/activity inclusion rules, and the same coverage qualifications as row queries.                     |
| Get transaction evidence   | Stable transaction and source-revision IDs, original statement/row/page locator, field provenance, correction status and permitted document access.         |
| Get coverage and freshness | Account/period availability, unresolved items, last acquisition/reconciliation, dataset revision and whether the service is reachable.                      |

Responses include a schema version, stable IDs, dataset revision/as-of time,
source references and explicit incomplete/truncated status. Queries must not
silently cross currencies, include unresolved transactions as settled facts,
or imply full history when only selected periods were obtained. Expose typed
bounded queries to AI clients, not unrestricted SQL or database credentials.

The financial database owns canonical transaction identity and reconciliation.
Kith Mind may link to those records or maintain a deliberate read projection;
it must not independently create a competing authoritative transaction set
from the same statements. An optional projection uses stable upstream IDs,
revision checkpoints, idempotent updates and deletion tombstones. Map its
semantics to existing Kith Mind financial records/query capabilities where
appropriate rather than forcing incompatible investment activity into them.

## Local and cloud boundary

Keep the database local unless the implementation decision says otherwise.
Use authenticated service access scoped to the owner's existing Kith Mind
space/account selection. No new family-sharing UI or permission system is
required for v1; the contract retains explicit scope for later multi-user use.

Desktop operation is primary. The architecture should allow an authorized
cloud-accessible read service or an explicitly chosen hosted read projection
later. Do not expose a raw database port to the internet. Cloud/mobile access
must report whether it is querying current local data, a dated projection, or
an unavailable source. If the computer is offline and no approved projection
covers the question, Kith Mind should state what information is available and
that the desktop service is needed for the remainder. Native mobile connector
support remains provider-dependent and a later priority.

## Acceptance and handoff

The independent team supplies the agreed schema/API, synthetic dataset,
contract tests, coverage manifest, exact-arithmetic/reconciliation tests and
restore evidence. The Kith Mind adapter is accepted when it can answer, with
transaction evidence and coverage qualifications:

- What transactions match a payee or description during a selected period?
- How much was spent in a selected currency and period, with transfer rules
  stated and missing history disclosed?
- Which statement supports a specific transaction, and was it corrected?
- Which accounts and periods are missing or not yet reconciled?

Test repeated imports without duplicates, corrected records replacing current
answers while preserving history, scope denial, unavailable local service,
stale projections and exact totals.
