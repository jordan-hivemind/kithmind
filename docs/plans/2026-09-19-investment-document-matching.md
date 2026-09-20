# Investment document matching and the attention queue

Date: 2026-09-19
Status: adopted, in build. Slice 2 of section 8 is the last slice landed
(ADM-8c); slices 3 to 7 are not built. Extends section 12 of
[`2026-09-18-admin-panel-and-ingestion.md`](2026-09-18-admin-panel-and-ingestion.md),
which fixed the auto-link rule but not the pipeline, the queue or the alerts.

Where the implementation has settled a question this plan left open, it says
so in place: see "Migrations", "Which one is the source of truth" and "What
slice 1 settled that this plan did not" in section 3, and "What slice 2
settled that this plan did not" in section 2.

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
database work, so it needs no pooled handler. Migration 034 widens the queue's
`kind` CHECK, and `packages/kith-store/src/admin/investmentLinkWork.ts` holds
the kind, the triggers and the backfill (ADM-8c).

ONE JOB PER DOCUMENT, whatever woke it. The plan's table gave the entry
trigger its own payload and its own key; the implementation does not, and the
reason is in the table below.

| Trigger | Payload | Dedupe key |
| --- | --- | --- |
| Extraction stored or re-stored | `{ spaceId, sourceItemId }` | `investment_link:item:<sourceItemId>` |
| Entry or investment created or edited | one job per affected document | `investment_link:item:<sourceItemId>` |
| An owner rejection frees an entry | one job per affected document | `investment_link:item:<sourceItemId>` |

Scheduled from `store` in `packages/kith-store/src/extraction/model.ts`, from
`createInvestment`, `updateInvestment`, `archiveInvestment`,
`createInvestmentEntry`, `updateInvestmentEntry` and `deleteInvestmentEntry`
in `packages/kith-store/src/admin/investments.ts`, and from
`rejectInvestmentDocumentLink` in
`packages/kith-store/src/admin/investmentLinks.ts` -- each in the transaction
of the write that caused it, so the job commits with that write or not at all.

The nightly sweep the plan lists as a third trigger is slice 3's, with the
detectors it exists to run, and `investment_sweep` is therefore not a kind
yet: a CHECK widened for a writer that does not exist is a CHECK nothing
tests, which is the same reasoning migration 033 applied to this one.

The operator route for the documents that were extracted before any of this
existed is `kith-investment-link-backfill` (dry run by default, `--apply`,
`--space`, `--kind`, `--limit`). It enqueues and never evaluates inline, and
it prints counts only.

### What slice 2 settled that this plan did not (ADM-8c)

| Question the plan left open | What was built, and why |
| --- | --- |
| The entry trigger's payload and key | One job per DOCUMENT, keyed `investment_link:item:<sourceItemId>`, for every trigger. An entry-keyed job would have to re-derive the documents anyway, and two key shapes over the same work do not de-duplicate against each other: a save and a re-extraction landing together would have produced two jobs that reached the same conclusion, and the second would have rewritten the rows the first had just written. |
| Which documents an edit wakes | Two halves. Every document already holding a link row for the investment is enqueued, always and unbounded: a live link left standing behind an amount that has moved is silent wrong data. Every other document matching on party, path or the entry's amount is enqueued too, bounded, because missing one costs a suggestion rather than a fact. |
| How those documents are found | A bounded read of the space's extractions of matchable kinds, filtered in JavaScript with the scorer's own `normalizeMatchName`, `pathNamesFromUri` and `amountMatches`. Not in SQL: re-expressing the rule that decides where the owner's money is filed would be a second implementation of it, and the two would drift. |
| Which edits count as match-affecting | For an entry, whether `entry_type`, `entry_date`, `amount`, `currency`, `exchange_rate` or `date_is_estimated` is a DIFFERENT STORED VALUE, asked in SQL with `IS DISTINCT FROM` over `numeric`. The drawer sends the whole entry on every save, so "he touched the amount field" is not the question, and a string compare would have enqueued a document every time he edited a note. For an investment, `name` and `signed_on` only. |
| Archiving and deleting | Both wake the documents involved. An archived investment leaves the matcher's view (`loadInvestmentNames` excludes it) and a deleted entry takes its link rows with it, so in both cases a live link would otherwise stand behind a decision nothing can still justify. |
| What the handler does with a bound it cannot score past | `candidate_limit` and `investment_limit` from the scorer are TERMINAL: `failed` on the first run, with the reason in the scrubbed `last_error`, and no attempt consumed. `drain` learned one new outcome for this (`TerminalDeferredWorkError`, `status: "terminal"`). Five identical attempts over fifteen minutes reach the same state and bury the reason under four copies of itself. |
| What a job that links nothing does | Nothing, silently. No attention row, no correction, no log line. Most of the owner's 142 entries will never have paper behind them; a job per document announcing that it found none is the noise this design treats as a defect. |
| A document whose kind stops being matchable | Still not swept, and not made worse: `evaluateDocumentLinks` returns `kind_not_matchable` before it sweeps anything, so gating the extraction trigger on the kind costs nothing the scorer does not already cost. It belongs with slice 3's nightly sweep. |

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
DEFAULT false`, in migration 033 (see "Migrations" below for why the number
moved). The import
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

This section was written as one migration numbered 028. It has become two,
and neither is 028. A version is a POSITION in `KITH_MIGRATIONS` and
`applyKithSchema` refuses a gap, so a number cannot be reserved ahead of the
ones beside it: 028 was spent by ADM-4b, and the attention queue's half landed
as **030** (ADM-8a). The link table's half is **033**
(`033_investment_document_links.sql`, ADM-8b), and what remains -- the two
deferred-work kinds -- belongs to slice 2 and will take its own position.

Migration 030 (ADM-8a) delivered items 4 and 5 in a different and better
shape: `corrections` gained `severity`, `detector`, `dedupe_key`,
`dismissed_at`/`dismissed_by`/`dismiss_reason` and `snoozed_until` with the
`dismissed` and `snoozed` states, and the suppression list is
`kith.attention_mutes` (`scope_kind`/`scope_value`) rather than
`kith.attention_suppressions`. Read that migration, not this paragraph, for
the queue's schema.

Migration 033 (ADM-8b, slices 1 and 1b) delivers:

1. `kith.investment_document_links`, its indexes, and a `kith.record_change`
   trigger (migration 023) so the screens update live.
2. A unique index on
   `(space_id, source_item_id, investment_id, coalesce(entry_id::text, ''))`.
   `investment_id` is in the key and the plan's version did not have it:
   without it a document could carry only ONE investment-level link, and an
   investment platform statement covers many investments at once. For an
   entry-level row it changes nothing, since an entry belongs to exactly one
   investment.
3. A partial index on `(space_id, entry_id, created_at, id)` over the live
   states, which is what makes the PRIMARY link cheap to find. There is
   deliberately no "one live link per entry" UNIQUE index: see "Which one is
   the source of truth" below for why an entry may carry a notice and the
   wire that paid it at once.
4. `kith.corrections.target_kind` extended with `entry` only. `investment`
   and `link` arrive with the detectors in slice 3 that write them: a CHECK
   widened for a writer that does not exist yet is a CHECK nothing tests.
5. The backfill that adopts every already-attached document as a link, and
   the `RAISE NOTICE` that counts what it adopted and what it could not.
6. Composite `ON DELETE SET NULL` keys name the column they clear --
   `SET NULL (document_id)`, `SET NULL (date_correction_id)`. A bare
   composite `SET NULL` nulls every column of the key, `space_id` included,
   which is NOT NULL, so the delete fails with 23502 instead. Migration 022's
   own `investment_entries.document_id` and `evidence_span_id` keys carry the
   same defect and are repaired here: deleting a document that an entry cited
   used to fail outright, and a re-parse that removes a document row is
   exactly what this feature makes routine.
7. `investment_entries.date_is_estimated`, defaulting false, so every existing
   row reads as owner-entered and none can be rewritten by this feature.

The `kith.deferred_work` kind check is NOT extended here. `investment_link`
belongs to slice 2, with the handler and the triggers that use it, and it
landed there as migration **034**
(`034_investment_link_deferred_kind.sql`, ADM-8c). `investment_sweep` still
has no migration: it waits for slice 3, which is the row that writes it.

Every query in `extraction/corrections.ts` filters `target_kind = 'document'`,
so the widened check disturbs no existing path.

### Which one is the source of truth (ADM-8b)

`kith.investment_document_links` is. `investment_entries.document_id` keeps
the meaning it has had since migration 022 -- the entry's primary citation,
read by the totals, the screen and `get_investment` -- but nothing writes it
directly any more. It is a MIRROR: the document of the entry's PRIMARY link,
or null. `syncEntryDocument` in
`packages/kith-store/src/admin/investmentLinks.ts` is the only writer, and it
runs in the same transaction as every link write. A whole-table consistency
query in `test/investmentLinks.test.mjs` runs after every transition and
fails if the two ever disagree.

**More than one live link, and the primary.** An entry may carry several live
(`auto_linked` or `confirmed`) links: a capital call notice and the wire
confirmation that paid it are both the paper for one payment. The first
implementation allowed only one, and the second document then sat as a
suggestion nobody could act on, which is noise. The PRIMARY link is the
OLDEST live one, by `created_at` then `id`, and it alone decides the mirror
and the date rule. Oldest rather than newest and rather than "the confirmed
one", because it is the only ordering that does not move under the owner:
confirming a second document must not silently re-point the first one's
citation. Rejecting the primary promotes the next live link, and the date
rule then runs again for the promoted one under the same guards.

**Adopting what is already attached.** Every drawer attachment made before
migration 033 set `document_id` with no link row behind it, and the old build
goes on making more of them between the schema apply and the deploy. Such an
entry reads to the matcher as an entry with no document, so the first notice
that scores ten points auto-links over the owner's own choice and the mirror
moves with nothing recording it. Migration 033 therefore backfills a
`confirmed`, `decided_by = 'owner'`, `reason = 'legacy_attached'` link for
each one, dated at the ENTRY's own `created_at` so it is the primary; the
same statement is `adoptLegacyEntryDocuments`, reachable from
`scripts/investment-links-adopt.mjs` (dry run by default), to be run once more
after the deploy. `syncEntryDocument` adopts one it meets at runtime for the
same reason, and NEVER clears a mirror it cannot account for: when the
document row is gone or has no source item, the mirror is left exactly as it
is and no link is invented.

**A document comes off an entry only through an explicit reject.** The
drawer's "attach this document" writes an owner-decided `confirmed` link. A
NULL `documentId` on an entry patch does nothing at all. It used to reject the
live link permanently and revert the date it had moved, and that was a loaded
gun: the drawer sends the whole entry on every save and the screen refreshes
its rows from the change feed while the drawer is open, so an automatic link
landing in that window turned the owner's next unrelated edit -- a note, a
rounded cent -- into a permanent rejection of a link he had never seen.
Removing a document is now `rejectInvestmentDocumentLink` and nothing else.
The drawer also sends `documentId`, `entryDate` and `dateIsEstimated` only
when they differ from the values it was OPENED with (`entryPatchFields` in
`apps/web/src/lib/kith/investment-entry-patch.ts`), never from the live row,
which is the version that moves.

**A document is not blocked by a neighbour that arrived after it.** An entry
counts as already spoken for, and so refuses this document's auto-link, only
when it carries a live link from ANOTHER document and this document holds no
live link on it. Without the second half, confirming the wire beside an
auto-linked notice made the next re-evaluation of the NOTICE read the wire as
"this entry is taken": it refused its own auto-link, the sweep below demoted
it, and the date went back to the guess with the mirror on the wire. Stated
generally: a re-evaluation must never demote a row whose only disqualifier is
another live link on the same entry that arrived after it, and a live row of
the document's own is the proof that it did not.

**A decision that has not changed writes nothing.** The matcher runs nightly,
so a pass that reaches the same conclusion must not touch the row: rewriting
it with identical values still moves `decided_at`, still writes a new row
version, and still fires the `record_change` trigger the screens refresh
from. Both write paths therefore compare first -- the link upsert's
`ON CONFLICT ... DO UPDATE` has a `WHERE` that requires some stored column to
differ, and `syncEntryDocument` reads the mirror before writing it. The tests
snapshot each link's id and both timestamps along with the count of
`kith.changes`, so "nothing moved" means the rows were not touched rather
than merely that they still say the same thing.

**A rule's auto-link is the rule's to take back.** When a rule-made
`auto_linked` row stops qualifying -- a second identical entry appears, the
document's party or amount is corrected, the document now names no investment
at all -- the pass reverts the date it replaced, through the same recorded
correction a rejection uses, and demotes or deletes the row. Nothing is
remembered: a demotion is not a rejection, because the owner said nothing. An
owner-decided row is never swept, whatever the rule now thinks. And a
re-extraction that changes the date on a still-qualifying primary link moves
the entry only while the entry still holds the date THAT LINK wrote; if the
owner has typed over it since, his date stands.

### What slice 1 settled that this plan did not (ADM-8b)

| Question the plan left open | What was built, and why |
| --- | --- |
| Which money value on a page counts as the amount | ONE field per kind (`amount_called`, `amount_sent`, `amount_distributed`, `amount_committed`), not "any money value". A call notice prints `total_commitment` beside the amount it is calling, and matching on that links a notice to a commitment entry. |
| Which entries a kind may be about | A kind names its entry types: a capital call notice never proposes itself against a distribution. A kind this scorer has no rules for produces no candidates at all, rather than being scored on coincidences. |
| How a partial date scores | It does not. `precision: "year"` and `"month"` satisfy no window at any kind and replace no date. The alternative is a fabricated day, and a fabricated day is what would then be read back as fact. The cost is a suggestion instead of an auto-link, which is the safe direction. |
| The `investment_agreement` window when `signed_on` is null | It falls back to +/-90 days around the ENTRY's date. An imported commitment's date is estimated exactly when the sheet had no Docs Signed date, which is exactly when `signed_on` is null -- so anchoring only on `signed_on` would make the window unavailable in the one case the date rule exists for. |
| Which direction a cross-currency compare runs | The rate lives on the entry (migration 025), so a non-USD ENTRY is compared with a USD document within the importer's tolerance. A non-USD DOCUMENT against a USD entry has no recorded rate and scores no amount point; inventing a market rate is the fabrication this design refuses. |
| What the 1% is 1% OF | The document's own stated amount, not the converted one, which is what the importer measures against (the sheet's own USD column). The two are not the same number below the converted figure, and the first implementation used the converted one -- a GBP call the importer had accepted could be a call the matcher refused. `apps/web/src/lib/kith/rate-tolerance-parity.test.ts` runs both implementations over one table of cases and is what caught it. |
| `schedule_k1`'s date window | It has none. `tax_year` is a number field, not a date (`extraction/seed.ts`), so a K-1 links at the investment level on its party alone. |
| What a tie is, exactly | An auto-link needs the best candidate to lead the runner-up by MORE than `LINK_TIE_MARGIN_POINTS` (2), so a three-point gap. Two candidates that both fire party, amount and date link nothing whatever the gap. |
| What rejecting does to a date the link replaced | It puts it back, and marks it estimated again, and records the reversal as its own resolved correction. The exception is the owner's: if he has edited the date since, his value stands and the marker is left as he left it. |
| A document whose date equals the estimate | The marker is cleared and NO correction row is written. Nothing changed, and a digest line saying "2026-03-01 became 2026-03-01" is noise. |
| Legacy estimated commitments from the ADM-3b import | Not back-marked. They carry the note "date estimated from first payment" and keep it; a backfill keyed off a free-text note is the kind of guess that becomes a silently wrong date. Every pre-033 row reads as owner-entered. |
| Section 1's three new document kinds | Not seeded here. The scorer names `wire_confirmation` and `capital_account_statement` in its kind table already, so it needs no change on the day extraction learns to read them; a kind no document carries simply never appears. |

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
migration 033; `corrections` and `investment_entries` already have one.

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
| 1 | Migration 033, link table, deterministic scorer | Synthetic fixtures produce the right auto, suggest and none decisions | Yes, it writes `investment_entries.document_id` |
| 1b | Estimated-date marker, import change, date replacement rule | An estimated date moves and is recorded; a non-estimated one never does | Yes, it changes a financial date |
| 2 (landed, ADM-8c) | `investment_link` kind, three triggers, backfill command | Fixture documents link themselves through one drain | No |
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
