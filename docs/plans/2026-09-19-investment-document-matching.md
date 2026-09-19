# Investment document matching and the attention queue

Date: 2026-09-19
Status: proposed. Extends section 12 of
[`2026-09-18-admin-panel-and-ingestion.md`](2026-09-18-admin-panel-and-ingestion.md),
which fixed the auto-link rule but not the pipeline, the queue or the alerts.

The owner enters the dollars. The system finds the paper, says nothing when it
succeeds, and reaches him when it cannot. Silent wrong data is the one
unacceptable failure, so every automatic link cites the statements that justify
it, the way `packages/kith-store/src/extraction/gate.ts` makes a stored value
cite a quote.

## 1. Document kinds to add as data

`packages/kith-store/src/extraction/seed.ts` already seeds
`investment_agreement` (subscription, SAFE and note terms in one kind),
`capital_call_notice`, `distribution_notice` and `schedule_k1`. Three kinds are
missing. Each is a row in `kith.document_types` plus rows in
`kith.document_type_fields` (migration 022).

| Kind | Fields (value type, check) | Why |
| --- | --- | --- |
| `wire_confirmation` | `sender` (organization, on_page, required), `amount_sent` (money, exact, required), `value_date` (date, exact, required), `beneficiary_as_written` (text, on_page), `wire_reference` (identifier, on_page) | The proof a call was paid, carrying the exact amount and date the entry claims. The strongest signal the folder holds. |
| `capital_account_statement` | `fund` (organization, on_page, required), `period_end` (date, exact, required), `period_start` (date, exact), `ending_capital_balance` (money, exact), `contributions_period` (money, exact), `distributions_period` (money, exact), `ownership_percent` (number, exact) | The quarterly report. The only independent check on cumulative calls and distributions. |
| `investment_platform_statement` | `platform` (organization, on_page, required), `period_start` (date, exact), `period_end` (date, exact, required), `total_invested` (money, exact), `total_value` (money, exact), `distributions_period` (money, exact) | It covers many investments at once and must not be read as one fund's notice. |

Two optional field additions, for matching rather than reading:
`capital_call_notice` gains `investor_as_written` (text, on_page) and
`distribution_notice` gains `wire_reference` (identifier, on_page).

Currency is not a field. `currencyOnPage` in `gate.ts` reads it off the page and
flags `currencyAssumed` when the page states none, which is what makes a GBP
notice safe to compare with a GBP entry.

## 2. Matching as deferred work

One new deferred kind, `investment_link`, registered in
`packages/kith-store/src/deferred/registry.ts`. Transaction scoped: it is all
database work, so it needs no pooled handler.

| Trigger | Payload | Dedupe key |
| --- | --- | --- |
| Extraction finished | `{ spaceId, sourceItemId }` | `investment_link:item:<sourceItemId>` |
| Entry created or edited | `{ spaceId, entryId }` | `investment_link:entry:<entryId>` |
| Nightly sweep | `{ spaceId }` | `investment_sweep:<spaceId>:<yyyy-mm-dd>` |

Scheduled from `store` in `packages/kith-store/src/extraction/model.ts`, from
`createInvestmentEntry` and `updateInvestmentEntry` in
`packages/kith-store/src/admin/investments.ts`, and from a sweep in
`packages/kith-store/src/deferred/sweeps.ts` that `tick` runs on the owner
machine's daemon.

### Candidates

Candidates come from typed statements, not text: the `document_statement`
observations `model.ts` writes. They replace the string matching in
`suggestDocumentsForEntry`.

| Signal | Rule | Points |
| --- | --- | --- |
| Party | A document organization value (`fund`, `company`, `partnership`, `issuer`, `platform`, `sender`) whose normalized form equals `investments.name` or an alias of its entity | 4 |
| Amount | A document money value equal to the entry amount under `compareDecimals`, same ISO currency, no tolerance | 4 |
| Date | The document's own date field inside the kind's window | 2 |
| Path | A normalized segment of `source_items.uri` equal to the investment name or an alias | 1 |

Windows: `capital_call_notice`, `wire_confirmation` and `distribution_notice`,
30 days either side of the entry date; `investment_agreement`, 90 days around
`investments.signed_on`; `schedule_k1`, the tax year;
`capital_account_statement`, the quarter containing the entry.

Decision, owner, 2026-09-19: a GBP document now scores amount against a USD
entry, and the reverse. The entry's own `exchange_rate` (migration 025)
converts the document money into the entry's currency, and the compare reuses
the importer's own rate-check tolerance rather than inventing a new one:
`apps/web/src/lib/kith/investment-import.ts` accepts a converted amount within
the larger of 1% (`RATE_TOLERANCE_FRACTION = 100n`) or $1.00
(`RATE_TOLERANCE_FLOOR_CENTS = 100n`) of the target. A converted amount inside
that tolerance scores the full 4 amount points, so a cross-currency match can
reach `auto_linked` the same way a same-currency one does.

### Decision

| Outcome | Condition |
| --- | --- |
| `auto_linked` | Party, amount and date all fire (10 points), kind is `capital_call_notice`, `distribution_notice` or `wire_confirmation`, exactly one entry qualifies, and that entry's `document_id` is null |
| `suggested` | 4 points or more, or any gated model proposal |
| Nothing | Below 4 |

Ties: two entries at 10, or a best two within 2 points, link nothing and
suggest both. A tie is the shape of two identical capital calls in one month,
which is where a guess goes wrong.

### Where a model is used

Only for leftovers: an investment-kind document whose deterministic pass gave
no candidate at 4, or a tie. One call per document, through the provider seam in
`packages/kith-store/src/extraction/provider.ts`.

It sees the stored statements (field, value, page, quote) from
`kith.document_extractions.statements` and at most 25 candidate entries as name,
type, date, amount, currency. Never page text, never another space.

It returns `{ entryId, citedFields }` or nothing, and code gates that: the cited
fields must exist in the stored statements, the cited money must equal the entry
amount and currency exactly, and the cited date must fall in the window. A pass
becomes `suggested` with `decided_by = 'model'`. A model answer can never
produce `auto_linked`; a gate failure opens an attention item.

## 3. Data model

One new table. An investment-level link (K-1, report, agreement) is a row with
`entry_id` null.

```
kith.investment_document_links
  id, space_id, created_at
  investment_id   not null, composite FK to kith.investments
  entry_id        nullable, composite FK to kith.investment_entries
  document_id     composite FK to kith.documents
  source_item_id  the identity that survives a re-parse
  state           auto_linked | suggested | confirmed | rejected
  score, signals jsonb
  evidence        jsonb: [{ field, observationKey, evidenceSpanId }]
  decided_by      rule | model | owner
  decided_at, actor_user_id, model, reason
```

`source_item_id` is carried for the reason migration 027 gives: a re-parse mints
new `kith.documents` rows and the source item survives it. Provenance is
`decided_by` plus `evidence`, and a link with no evidence is refused at write.

`investment_entries.document_id` and `evidence_span_id` (migration 022) stay as
the entry's primary citation, set only for `auto_linked` and `confirmed`, so the
totals, the screen and `get_investment` keep working unchanged.

A `rejected` row is never deleted and candidate generation skips any (source
item, entry) pair that has one, so a rejection survives re-extraction.

Aliases reuse `kith.entities.aliases` and `normalized_aliases`, maintained by
`resolveEntity` in `packages/kith-store/src/memory/entities.ts` and already
pointed at by `investments.entity_id`. No alias table is added.

Re-evaluation: when extraction rewrites a document's observations the job
re-checks every link's cited evidence. Evidence that is gone or no longer equal
drops an `auto_linked` row to `suggested` and opens an attention item; a
`confirmed` row is left alone and opens one, because a model does not overturn a
human decision. A resolved correction rewrites the observation through
`writeThrough` in `packages/kith-store/src/extraction/corrections.ts`, so the
same re-check turns a corrected amount into a clean link.

### Estimated dates

Owner requirement, 2026-09-19: many imported commitments have no signing date,
so the import dates them at the first payment and marks the date estimated.
Some payment dates are estimates too. A matched document that states the real
date should correct the estimate.

The marker is one column, `investment_entries.date_is_estimated boolean NOT NULL
DEFAULT false`, in migration 028. The import
(`apps/web/src/lib/kith/investment-import.ts`) sets it, replacing section 12's
rule that a commitment row without a signed date is unimportable. An entry the
owner types is marked only if he ticks the box in the drawer.

| Entry type | Document date that may replace an estimate |
| --- | --- |
| `commitment`, `commitment_change` | `investment_agreement.date_signed` |
| `capital_call_paid` | `wire_confirmation.value_date`, else `capital_call_notice.due_date` |
| `distribution` | `distribution_notice.distribution_date` |

Automatic replacement needs all of: `date_is_estimated` is true; the link is
`confirmed` or `auto_linked`; the date observation passed the gate; and exactly
one document offers a date. The job writes the new `entry_date`, clears the
marker, and records the change as a resolved `kith.corrections` row
(`target_kind = 'entry'`, `field_name = 'entry_date'`, old date as
`original_value`, new as `corrected_value`, cited observation and span in
`reason`). That table already keeps an original beside a correction, so no
history table is added, and every such change is listed in the daily digest.

A non-estimated date is never overwritten. If it disagrees with a confirmed
document by more than 3 days, the detector below opens an item instead and the
panel offers Use the document's date or Keep mine. Two documents offering
different dates for one estimated entry also open an item.

### Commitments

Owner requirement, 2026-09-19: a fund investment should record a total
commitment that capital calls count against. The model already does this;
this design references it rather than building a second one.

`kith.investment_entries` already carries a `commitment` entry per investment
and a signed `commitment_change` for every increase or reduction (the one
entry type allowed to be negative, `SIGNED_ENTRY_TYPE` in
`packages/kith-store/src/admin/investments.ts`). The totals query in the same
file computes `committed = commitment + commitment_change`,
`outstanding = committed - sent` (signed, not floored at zero), and
`overCalled = greatest(sent - committed, 0)`. The `over_called` detector and
"calls exceed commitment" below read this same `overCalled` figure; it is not
a new computation. The Investment row panel in section 6 shows the same
totals the drawer already renders.

A commitment is edited the way any entry is: open the investment's drawer
(`apps/web/src/components/admin/investment-drawers.tsx`) and edit or add a
`commitment` or `commitment_change` row. A fund that commits in a currency
other than USD (a GBP commitment, say) is entered in that currency with its
own `exchange_rate`, the same field a capital call or distribution uses. The
drawer's USD figure is `amount * exchange_rate` at the owner's entered rate,
not a market conversion, so it reads as estimated, the same caveat
`exchange_rate` already carries for every non-USD entry, not a new one.

### Migrations

One migration, `028_investment_links_and_attention.sql`:

1. `kith.investment_document_links`, its indexes, and a `kith.record_change`
   trigger (migration 023) so the screens update live.
2. A unique index on `(space_id, source_item_id, coalesce(entry_id, ''))`.
3. `kith.deferred_work` kind check extended with `investment_link` and
   `investment_sweep`, as migration 027 extended it.
4. `kith.corrections`: `target_kind` extended with `entry`, `investment` and
   `link`; columns `class` (`money_at_risk`, `system_breakage`, null for a
   quiet queue item), `detector`, `dedupe_key`, `snooze_until`, `last_seen_at`,
   `last_alerted_at`, `alert_count`; a unique index on `(space_id,
   dedupe_key)` where `state = 'open'`.
5. `kith.attention_suppressions`: `id, space_id, created_at, actor_user_id,
   reason, scope, detector, investment_id, before_date`. `scope` is
   `detector`, `investment`, or `before_date`, backing bulk dismiss and the
   per-investment and per-detector "do not track documents" switches
   (section 4). The sweep checks it before opening a row, the same place it
   already checks for an open dismiss.
6. `investment_entries.date_is_estimated`, defaulting false, so every existing
   row reads as owner-entered and none can be rewritten by this feature.

No second migration. Every query in `extraction/corrections.ts` filters
`target_kind = 'document'`, so the widened check disturbs no existing path.

## 4. Discrepancy detection

Owner principle, 2026-09-19, quoted because it drives every rule below: "this
is a best-effort personal store; records will be incomplete; do not chase the
owner for information he does not have; warnings about holes must not become
so noisy that he misses what he cares about."

Detectors run in the nightly sweep. Each is a query over current rows, so all
auto-close. Only two classes ever alert; everything else is a quiet queue item
that sits in Needs attention until it is resolved, dismissed, or auto-closes.
The old low/medium/high ladder is gone: a detector either belongs to an
alerting class or it does not.

| Class | Detectors | Why it alerts |
| --- | --- | --- |
| Money at risk | `call_due_unpaid`, `over_called` | A capital call notice with no matching payment near or past its due date, or cumulative calls exceeding the commitment (section 3, "Commitments"), are the two shapes of losing track of the owner's own money |
| System breakage | Pipeline stalled, alerter silent (the heartbeat check below) | If the system itself has stopped working, that is the one thing worth interrupting him for |
| Quiet queue, never alerts | `entry_without_document`, `notice_without_entry`, `amount_or_date_mismatch`, `entry_date_disagrees` | Missing paperwork and disagreements he can look at whenever he opens the screen, never a reason to interrupt him |

| Detector | Rule | Class | Auto-closes |
| --- | --- | --- | --- |
| `entry_without_document` | A `capital_call_paid` or `distribution` entry older than 14 days with no `auto_linked` or `confirmed` link | quiet queue | when a link lands, or is dismissed |
| `notice_without_entry` | A call or distribution notice with no link to any entry 7 days after extraction | quiet queue | when a link lands, or is dismissed |
| `call_due_unpaid` | A notice whose `due_date` is within 7 days or past, with no matching `capital_call_paid` entry | money at risk | when a matching entry exists |
| `amount_or_date_mismatch` | A candidate matching on party and date whose money differs from the entry, or whose date is outside the window | quiet queue | when the entry is corrected or the link is rejected |
| `entry_date_disagrees` | A confirmed or auto-linked document's date differs by more than 3 days from an entry date that is not marked estimated, or two documents offer different dates for an estimated one | quiet queue | when the entry is edited or the link is rejected |
| `over_called` | Cumulative `capital_call_paid` above committed (`overCalled` in the totals CTE of `admin/investments.ts`, section 3) | money at risk | when a commitment change or correction clears it |

Extraction gate failures already open `corrections` rows and need no detector.
They appear in the queue because it is one table, and they are quiet unless
they happen to be one of the two alerting classes above.

A quiet queue item never escalates and never repeats: it is written once, sits
until resolved, dismissed, or no longer produced by the sweep, and no cadence
in section 5 ever reads it.

### Missing K-1s: a checklist, not a detector

Owner requirement, 2026-09-19: a missing K-1 is never an alert and never a
queue item. The owner typically receives K-1s in late August or September and
cannot make them arrive sooner, so a March or April threshold (the earlier
design's `k1_missing` detector, removed here) produces months of noise about
something he cannot fix.

In its place, a pull-only checklist: "which K-1s do I have for year Y", shown
on request in the Needs attention screen (a tab, not a queue row) and through
MCP (`list_missing_k1s`, section 7). For a chosen tax year it lists every
investment with an entry that year and no linked `schedule_k1` for it. Nothing
schedules it and nothing pushes it; it runs only when asked.

### Dismissing and turning off tracking

Because many entries will stay permanently undocumented, every quiet queue
item gets a one-click permanent dismiss, labelled "not worth backfilling" in
the UI. A dismissed key is resolved with that reason and no snooze end, and
the detector that produced it never reopens that key (the `Dismiss` rule in
section 5's Behaviour table).

Bulk dismiss covers the common cases without repeating the click per row.
`kith.attention_suppressions` (section 3): `scope` is `detector` (suppress a
whole detector, space-wide), `investment` (suppress a whole investment's
items, any detector), or `before_date` (suppress a detector's items whose
target predates a cutoff: "all undocumented entries before 2019" in one
action). The sweep checks this table before opening a row, exactly where it
already checks `corrections` for an open dismiss, so a suppressed key is never
written rather than written and then hidden.

A per-investment and a per-detector "do not track documents" switch are the
standing form of the same table: a `scope = 'investment'` or `scope =
'detector'` row with no `before_date`, set from the investment's drawer or the
Needs attention screen's kebab and shown there as a toggle rather than a log
entry.

## 5. Attention queue and alerts

The queue is `kith.corrections` widened, not a new concept. The screen the plan
calls Corrections becomes Needs attention and shows every open row whatever its
`target_kind`. `list_review_queue`
(`packages/kith-store/src/records/reviewQueue.ts`) stays what it is: an
ingestion-class report keyed by source account.

| Behaviour | Rule |
| --- | --- |
| Qualifies | Any open row: gate failure, detector finding, stale link evidence |
| Deduplication | `dedupe_key` is `<detector>:<target>[:<period>]`, unique among open rows; a repeat run updates `last_seen_at` |
| Snooze | `snooze_until` hides the row from the default filter and from every alert until it passes |
| Dismiss | Resolve with a reason and no snooze end ("not worth backfilling" in the UI); a detector never re-opens a key whose newest row is resolved that way |
| Bulk dismiss | A `kith.attention_suppressions` row (section 4) stops a whole detector, a whole investment, or everything before a date from ever being written, not just from being hidden |
| Do not track | A standing `attention_suppressions` row with no `before_date`, set per investment or per detector, shown as a toggle rather than a log entry |
| Auto-close | The sweep resolves open rows whose key the detector no longer produces, reason `cleared` |
| Aging | `created_at` drives the age column |

Alerts are sent from the owner's always-on machine, because the webhook secret
is in that machine's Keychain and the hosted app must never hold it. The
existing daily health check script is extended, not replaced.

Owner requirement, 2026-09-19, on timing: every alert, whatever its class, is
held to the next local 08:00 window; nothing sends at night. A detection at
2am waits for that morning's run; a detection at 08:05 waits for the next
day's. There is no separate always-on immediate channel.

| Channel | Contents | Cadence |
| --- | --- | --- |
| 08:00 alert | Every open `money at risk` and `system breakage` item, new or still open | Once daily, 08:00 local, nothing outside that window |
| Daily digest | Open quiet-queue items by detector, items opened and auto-closed since yesterday, every auto-link (first 30 days of the feature) and every estimated date corrected that day, plus the health checks it already posts | Daily, same 08:00 run |
| Escalation | A money-at-risk or system-breakage item repeats at the next 08:00 run while it stays open; a quiet queue item never repeats | From `last_alerted_at` and `alert_count` |
| Weekly summary | Always sends, including "0 open", so silence means the alerter is broken | Weekly, at the 08:00 run |

Dead man check: each run updates a heartbeat row with
`dedupe_key = 'alerter_heartbeat'`; the Health screen derives a check from its
age, in the slot `BACKUP_CHECK` in `packages/kith-store/src/admin/status.ts`
reserves for work this app cannot see; and a second launchd job posts if that
heartbeat is over 36 hours old. If the machine is off nothing sends, and the
always-sending weekly summary is the cue. A silent alerter is itself a
`system breakage` item, so this check feeds the same alerting class it
guards.

## 6. UI

House style, with the existing components
(`apps/web/src/components/ui/data-table.tsx`,
`apps/web/src/components/admin/investments-table.tsx`).

| Place | Shows |
| --- | --- |
| Entry row | Pills: `linked`, `suggested` or `none`, and `estimated` on an estimated date; tooltip carries the cited quote; kebab: Confirm, Reject, Open document |
| Entry drawer | The top suggestion with its cited field and quote, Confirm or Reject beside it; the commitment total from section 3 alongside sent and outstanding |
| Investment row, expanded | Documents list: kind, date, state, and the entry each is linked to; a "do not track documents" toggle |
| Needs attention screen | Class (money at risk, system breakage, or unlabelled for quiet queue), detector, target, one-line detail, age; right-hand panel shows the evidence; kebab: Confirm, Reject with reason, Use the document's date, Snooze 7 or 30 days, Dismiss ("not worth backfilling"), Bulk dismiss (before a date, whole investment, whole detector) |
| K-1 checklist tab | Pull-only, on request: pick a tax year, see every investment missing a `schedule_k1` for it. No badge and no count on the main screen |

Live updates come from the change feed. The new table gets its trigger in
migration 028; `corrections` and `investment_entries` already have one.

## 7. MCP

No new write tools. All of it through the existing authorization in
`apps/web/src/lib/mcp/reads.ts`.

| Tool | Addition |
| --- | --- |
| `get_investment` | Each entry gains `documents: [{ documentId, sourceItemId, kind, state, citedFields: [{ field, value, quote, evidenceSpanId }] }]`, plus investment-level documents for K-1s and reports |
| `list_investments` | `needsAttentionCount` per investment |
| `list_attention` (new, read only) | Open items: detector, class (money at risk, system breakage, or none for quiet queue), target, one-line detail, age, citation ids, snooze state |
| `list_missing_k1s` (new, read only) | Pull-only checklist for a tax year: every investment with an entry that year and no linked `schedule_k1` |

Both questions are then one call each, with exact decimal amounts.

## 8. Build order

| Slice | Delivers | Testable at the end | Second-model review |
| --- | --- | --- | --- |
| 1 | Migration 028, link table, deterministic scorer | Synthetic fixtures produce the right auto, suggest and none decisions | Yes, it writes `investment_entries.document_id` |
| 1b | Estimated-date marker, import change, date replacement rule | An estimated date moves and is recorded; a non-estimated one never does | Yes, it changes a financial date |
| 2 | `investment_link` kind, three triggers, backfill command | Fixture documents link themselves through one drain | No |
| 3 | Attention items, the six detectors, bulk dismiss and do-not-track suppressions | Fixtures open items and clear them next sweep; a suppressed key never opens one | No |
| 4 | Investments pills and actions, Needs attention screen, K-1 checklist tab | Confirm and reject round trip, live with no refresh; checklist matches fixtures on request | No |
| 5 | Digest, immediate alerts, weekly summary, heartbeat | A dry run prints each payload without posting | No |
| 6 | MCP additions | Read tools answer both questions with citations | Yes, MCP exposure |
| 7 | Model-assisted leftovers behind the gate | A wrong model answer opens an attention item, never a link | Yes |

Measure on the first real run: auto-link rate (auto-linked over investment
documents extracted), suggestion acceptance (confirmed over offered), false
links found (rejected after auto-linking, target zero), documents with no
candidate, and items opened against auto-closed.

## 9. Decisions (owner, 2026-09-19)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Auto-link silently from day one, or suggest everything for 30 days? | Auto-link from day one. Every auto-link still lists in the daily digest for the first 30 days (section 5) |
| 2 | Auto-link a GBP document to a USD entry with the recorded rate? | Yes, within the importer's own tolerance: the larger of 1% or $1.00 (section 2) |
| 3 | Days before an entry with no document is raised, and how noisy should that be? | 14 days, and it is never an alert. Missing-document items are informational, quiet queue items only. See the guiding principle and the two-class detector table (section 4) |
| 4 | When is a missing K-1 a problem? | Never an alert or queue item. A pull-only checklist, shown on request (section 4, "Missing K-1s: a checklist, not a detector") |
| 5 | Immediate alerts at night? | No alert of any class sends outside the next local 08:00 window (section 5) |
| 6 | Fund commitments? | The existing model already tracks a total commitment that calls count against; this design references it rather than adding a second one (section 3, "Commitments") |
