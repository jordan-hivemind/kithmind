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

A GBP entry is compared with GBP document money only. It carries an
`exchange_rate` (migration 025), but converting to compare would invent
precision, so a cross-currency pair is never scored on amount.

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

### Migrations

One migration, `028_investment_links_and_attention.sql`:

1. `kith.investment_document_links`, its indexes, and a `kith.record_change`
   trigger (migration 023) so the screens update live.
2. A unique index on `(space_id, source_item_id, coalesce(entry_id, ''))`.
3. `kith.deferred_work` kind check extended with `investment_link` and
   `investment_sweep`, as migration 027 extended it.
4. `kith.corrections`: `target_kind` extended with `entry`, `investment` and
   `link`; columns `severity`, `detector`, `dedupe_key`, `snooze_until`,
   `last_seen_at`, `last_alerted_at`, `alert_count`; a unique index on
   `(space_id, dedupe_key)` where `state = 'open'`.
5. `investment_entries.date_is_estimated`, defaulting false, so every existing
   row reads as owner-entered and none can be rewritten by this feature.

No second migration. Every query in `extraction/corrections.ts` filters
`target_kind = 'document'`, so the widened check disturbs no existing path.

## 4. Discrepancy detection

Detectors run in the nightly sweep. Each is a query over current rows, so all
auto-close.

| Detector | Rule | Severity | Auto-closes |
| --- | --- | --- | --- |
| `entry_without_document` | A `capital_call_paid` or `distribution` entry older than 14 days with no `auto_linked` or `confirmed` link | low | when a link lands |
| `notice_without_entry` | A call or distribution notice with no link to any entry 7 days after extraction | medium | when a link lands |
| `call_due_unpaid` | A notice whose `due_date` is within 7 days or past, with no matching `capital_call_paid` entry | high | when a matching entry exists |
| `amount_or_date_mismatch` | A candidate matching on party and date whose money differs from the entry, or whose date is outside the window | high | when the entry is corrected or the link is rejected |
| `entry_date_disagrees` | A confirmed or auto-linked document's date differs by more than 3 days from an entry date that is not marked estimated, or two documents offer different dates for an estimated one | medium | when the entry is edited or the link is rejected |
| `over_called` | Cumulative `capital_call_paid` above committed (`overCalled` in the totals CTE of `admin/investments.ts`) | medium | when a commitment change or correction clears it |
| `k1_missing` | An investment with an entry in tax year Y and no `schedule_k1` with `tax_year = Y` by March 15 of Y+1, high from April 1 | medium then high | when the K-1 is extracted |

Extraction gate failures already open `corrections` rows and need no detector.
They appear in the queue because it is one table.

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
| Dismiss | Resolve with a reason and no snooze end; a detector never re-opens a key whose newest row is resolved that way |
| Auto-close | The sweep resolves open rows whose key the detector no longer produces, reason `cleared` |
| Aging | `created_at` drives the age column and the cadence below |

Alerts are sent from the owner's always-on machine, because the webhook secret
is in that machine's Keychain and the hosted app must never hold it. The
existing daily health check script is extended, not replaced.

| Channel | Contents | Cadence |
| --- | --- | --- |
| Daily digest | Open items by severity, items opened and auto-closed since yesterday, every auto-link and every estimated date corrected that day, plus the health checks it already posts | Daily |
| Immediate | `call_due_unpaid` within 7 days, and `amount_or_date_mismatch` | Every 30 minutes, 08:00 to 21:00 local |
| Escalation | High repeats every 3 days while open, medium weekly, low never repeats | From `last_alerted_at` and `alert_count` |
| Weekly summary | Always sends, including "0 open", so silence means the alerter is broken | Weekly |

Dead man check: each run updates a heartbeat row with
`dedupe_key = 'alerter_heartbeat'`; the Health screen derives a check from its
age, in the slot `BACKUP_CHECK` in `packages/kith-store/src/admin/status.ts`
reserves for work this app cannot see; and a second launchd job posts if that
heartbeat is over 36 hours old. If the machine is off nothing sends, and the
always-sending weekly summary is the cue.

## 6. UI

House style, with the existing components
(`apps/web/src/components/ui/data-table.tsx`,
`apps/web/src/components/admin/investments-table.tsx`).

| Place | Shows |
| --- | --- |
| Entry row | Pills: `linked`, `suggested` or `none`, and `estimated` on an estimated date; tooltip carries the cited quote; kebab: Confirm, Reject, Open document |
| Entry drawer | The top suggestion with its cited field and quote, Confirm or Reject beside it |
| Investment row, expanded | Documents list: kind, date, state, and the entry each is linked to |
| Needs attention screen | Severity, detector, target, one-line detail, age; right-hand panel shows the evidence; kebab: Confirm, Reject with reason, Use the document's date, Snooze 7 or 30 days, Dismiss with reason |

Live updates come from the change feed. The new table gets its trigger in
migration 028; `corrections` and `investment_entries` already have one.

## 7. MCP

No new write tools. All of it through the existing authorization in
`apps/web/src/lib/mcp/reads.ts`.

| Tool | Addition |
| --- | --- |
| `get_investment` | Each entry gains `documents: [{ documentId, sourceItemId, kind, state, citedFields: [{ field, value, quote, evidenceSpanId }] }]`, plus investment-level documents for K-1s and reports |
| `list_investments` | `needsAttentionCount` per investment |
| `list_attention` (new, read only) | Open items: detector, severity, target, one-line detail, age, citation ids, snooze state |

Both questions are then one call each, with exact decimal amounts.

## 8. Build order

| Slice | Delivers | Testable at the end | Second-model review |
| --- | --- | --- | --- |
| 1 | Migration 028, link table, deterministic scorer | Synthetic fixtures produce the right auto, suggest and none decisions | Yes, it writes `investment_entries.document_id` |
| 1b | Estimated-date marker, import change, date replacement rule | An estimated date moves and is recorded; a non-estimated one never does | Yes, it changes a financial date |
| 2 | `investment_link` kind, three triggers, backfill command | Fixture documents link themselves through one drain | No |
| 3 | Attention items and the seven detectors | Fixtures open items and clear them next sweep | No |
| 4 | Investments pills and actions, Needs attention screen | Confirm and reject round trip, live with no refresh | No |
| 5 | Digest, immediate alerts, weekly summary, heartbeat | A dry run prints each payload without posting | No |
| 6 | MCP additions | Read tools answer both questions with citations | Yes, MCP exposure |
| 7 | Model-assisted leftovers behind the gate | A wrong model answer opens an attention item, never a link | Yes |

Measure on the first real run: auto-link rate (auto-linked over investment
documents extracted), suggestion acceptance (confirmed over offered), false
links found (rejected after auto-linking, target zero), documents with no
candidate, and items opened against auto-closed.

## 9. Open questions

| Question | Recommended default |
| --- | --- |
| Auto-link silently from day one, or suggest everything for 30 days? | Auto-link on, with every auto-link listed in the daily digest for the first 30 days |
| Days before an entry with no document is raised? | 14 |
| When is a missing K-1 a problem? | Medium on March 15 of the following year, high on April 1 |
| Immediate alerts at night? | No, queue them to the next 08:00 window |
| Auto-link a GBP document to a USD entry with the recorded rate? | No, suggest only |
