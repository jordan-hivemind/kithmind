# Typed records and exact queries

P1-7 extends the [source-processing contract](./2026-09-06-source-processing-contract.md).
Records use the same worker lease, immutable evidence, processing generation,
and atomic publication boundary as documents. They do not depend on embeddings.

## Storage and publication

| Record        | Identity and behavior                                                                |
| ------------- | ------------------------------------------------------------------------------------ |
| Event         | Stable `(sourceItemId, eventKey)` identity                                           |
| Event version | Immutable `(eventId, processingGenerationId)` occurrence and classification          |
| Observation   | Logical `(eventId, observationKey)` with one immutable representation per generation |
| Evidence      | Field references to retained spans in that generation's text version                 |

Version 1 supports `lab_panel`, `vehicle_service`, and
`financial_transaction`. Lab events belong to person entities. Vehicles use
`other` entities until a dedicated vehicle kind is introduced. Financial
line items use money values. Different source items remain independent,
even if they describe similar events. Reviewed event links and cross-source
consolidation are deferred; queries do not deduplicate attachments by date,
name, or amount.

A generation admits at most 32 event versions and 128 observations. A staging
batch contains at most 25 combined event and observation records and 128 KiB.
Each field has at most 16 evidence references. Each returned event or
observation has at most 16 KiB of deduplicated evidence quotes; staging
enforces that bound before publication. Staging validates the full
space, source, revision, text, entity, and evidence parent chain. Exact retries
reuse immutable rows. Changed values under an existing version identity fail.
Corrections require a new processing fingerprint and retain the old versions.

Admission includes expected event and observation counts. Omitted counts mean
zero, preserving existing text-only receipts. Staging and activation check
actual counts even when the expected count is zero. No old free-text
`sourceRef` is promoted into typed evidence automatically.

## Values and dates

Values are a discriminated union of decimal, money, integer, text, boolean,
date, and entity. Decimal and integer values are canonical base-10 strings.
They reject exponents and implicit floating-point conversion. Decimal values
support at most 38 significant digits and 18 fractional places. Arithmetic
uses exact integer coefficients and rejects overflow.

Money requires a currency from the versioned Phase 1 subset of ISO 4217.
Totals remain grouped by currency. Units come from a versioned subset of
UCUM 2.2, using case-sensitive codes. For example, `[IU]/L` is a code;
`IU/L` may be retained as `originalUnit`. Unsupported currencies or units
fail explicitly. No implicit currency or unit conversion is performed.
The registries and authoritative source links live in
`packages/convex/convex/models/records/values.ts`.

Occurrence is an unknown date, a calendar date, or a finite millisecond
instant with its original UTC offset. Unknown dates stay unknown. Latest
queries exclude them and report the excluded count. Datetimes compare by
instant, including across different offsets. A date-only value has no
invented timezone: mixed-precision comparison uses its possible interval
across supported offsets from -14:00 through +14:00. Overlapping intervals
are ambiguous and return candidates rather than false precision.

Stable traversal uses local calendar date, precision, instant where present,
and stable record identity. This traversal order is distinct from a claim
of semantic recency across mixed precision or differing offsets.

## MCP surface

`query_records` accepts a `query` object discriminated by `operation`.
Every request names one explicit `spaceId`. Resolve entity IDs explicitly;
person linking and conversational `me` resolution are separate work.

| Operation             | Inputs                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `latest_observation`  | Entity, observation type, optional as-of and unit                         |
| `observation_history` | Entity, observation type, `[from,to)`, order, optional unit and cursor    |
| `latest_event`        | Entity, event type, optional as-of                                        |
| `list_events`         | Entity, event type, `[from,to)`, order and optional cursor                |
| `sum_money`           | Entity or source account, line-item type, `[from,to)` and optional cursor |

An optional source-account subset narrows the selected inventory. Current
membership, read capability, and credential space scopes are rechecked for
every page. Credential source-account grants authorize ingestion; they do not
restrict ordinary space-scoped reads. Internal snapshot and cursor bookkeeping is
permitted by read capability and does not permit writing source content.

## Consistency and forgetting

Snapshot queries retain a processing-generation boundary across pages.
Publication timestamps and reserved query snapshots share a monotonic clock,
so a correction published in the same millisecond cannot enter an older
snapshot. Explicit `consistency: "current"` requires restart after activation.

Cursors are opaque server-side sessions bound to the principal, current
authorization, normalized filter, source inventory, snapshot, and exact
accumulator. Expired or invalid cursors do not return accumulated totals.
Cursors are single-use. Advancing returns a new cursor and invalidates the
old one. A lost page response therefore requires restarting rather than
silently skipping another page. The session expires 15 minutes after the
initial query and does not extend on each page. At most 16 active sessions
are allowed per user and space. Restart from the initial query and discard
earlier pages when invalidation is reported.

Forget increments a separate visibility epoch immediately. Every earlier
query session in that space becomes invalid, including snapshot sessions.
Bounded cleanup purges those sessions and deletes observations and event
versions before source evidence. It also deletes stable event identities.
The existing non-content source tombstone prevents automatic resurrection.
New sessions cannot read the hidden source and do not delay old-session
cleanup.

A partial page is always incomplete. A terminal result may claim completeness
only for fresh coverage of the selected source inventory, record type,
entity, and date range, with no relevant gaps or pending work. Zero results
with unknown coverage mean no indexed match, not proof that no event occurred.

## Phase 1 limits

Each indexed candidate scan examines at most 256 rows. Latest operations
inspect separate date and instant indexes so import order cannot establish
recency. History and event-list pages return at most 25 records. Query
responses bound retained record output to 96 KiB and share a 2 MiB content
hydration budget across their main and undated scans. If a budget prevents a
complete answer, the result exposes exclusions or a continuation cursor.
It must not label a truncated result complete.

These tables and queries are exercised with synthetic records. The public
text ingestion worker is separate work, and automatic extraction from actual
lab reports, statements and receipts is not implemented by P1-7.
