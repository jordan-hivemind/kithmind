# Tax return extraction

Date: 2026-09-19
Status: proposed. Design only.

> Amended 2026-09-20: sensitivity re-scoped by the owner, see PR #319.
> Section 8 is rewritten to match what shipped: three levels
> (`normal`/`sensitive`/`restricted`), not the two (`low`/`high`) proposed
> below; the never-store-identifiers gate, identifier masking, MCP and search
> redaction, and the audit line were all removed from the design and did not
> ship. The per-key ceiling shipped as `api_keys.max_sensitivity`, defaulting
> to `restricted` (full access), lowered only by the owner. Section 10's
> slice 0 row and decision 8 in section 11 are updated to match.

Owner requirement, verbatim: "I'd like to be aggressive / broad about the
information we extract from the tax return and keep in Postgres. Not every line
item, but every total, so it's easy to run basic aggregations and calculations
without pulling the original documents."

This extends the typed extraction backend in
`packages/kith-store/src/extraction/`. The gate, the corrections queue and the
evidence spans are unchanged.


## Front-of-return extraction priority

Owner clarification, 2026-09-20: an assembled return can exceed 300 pages
because most pages are appended supporting statements. The return forms and
schedules needed to schematize the return are in the front section.

Start with the front return forms and schedules. Bookmarks, a contents page
or form headings can help choose an initial page range; keep that selection
lightweight. Expand the inspected range when a required form, schedule or
total is missing. A useful first pass can report the forms it covered without
classifying every attachment. Keep original PDF page numbers in citations and
report any missing coverage explicitly.

Attached K-1s and brokerage statements may be useful separate documents, but
they are not prerequisites for extracting the return totals. Do not count an
attachment amount again as a return total. Total PDF length alone must not
block the first useful tax-return extraction slice.

## 1. What "every total" means

A line is captured when it matches one rule below. Everything else is skipped.

| Rule | Example |
| --- | --- |
| A sum or subtotal on the same form | 1040 line 9, total income |
| A carry into or out of another form | Schedule 1 line 10 to 1040 line 8 |
| A tax, credit, payment, refund or amount owed | 1040 lines 16, 24, 33, 37 |
| A statutory box on an information return | W-2 box 1, K-1 box 1 |
| A per-entity total on a multi-entity schedule | Schedule E page 2, one row per fund |
| An identifying field | tax year, form, filing status, jurisdiction, preparer, counterparty |

Skipped: individual 8949 dispositions, individual Schedule A gifts, per-asset
4562 rows, anything that only feeds a captured total.

Line numbers move between years. AGI is 1040 line 11 in 2024 and line 37 in
2017. A fact therefore carries a stable `semantic_key` (`agi`), the form family,
the tax year, and the `line_ref` and `line_label` as printed that year.
Aggregation uses the key. Citation uses the printed reference. Nothing
aggregates by line number.

**Form 1040.** `wages_total` 1z, `tax_exempt_interest` 2a, `taxable_interest`
2b, `qualified_dividends` 3a, `ordinary_dividends` 3b, `ira_distributions` 4a,
`ira_taxable` 4b, `pensions_total` 5a, `pensions_taxable` 5b,
`social_security_total` 6a, `social_security_taxable` 6b,
`capital_gain_or_loss` 7, `additional_income` 8, `total_income` 9,
`adjustments_to_income` 10, `agi` 11, `deduction_taken` 12, `qbi_deduction` 13,
`total_deductions` 14, `taxable_income` 15, `tax` 16, `schedule_2_part_1` 17,
`child_tax_credit` 19, `schedule_3_part_1` 20, `total_credits` 21,
`other_taxes` 23, `total_tax` 24, `federal_withheld_total` 25d,
`estimated_payments_and_prior_overpayment` 26, `total_other_payments` 32,
`total_payments` 33, `overpaid` 34, `refunded` 35a, `applied_to_next_year` 36,
`amount_owed` 37, `estimated_tax_penalty` 38. Plus `tax_year`,
`filing_status`, `jurisdiction`, `filer_name_as_written`, `preparer_name`,
`signature_date`, `filing_channel`.

| Schedule | Captured lines (recent-year numbering) |
| --- | --- |
| 1 | 3, 4, 5, 7, 8z, 9, 10, 15, 16, 17, 20, 25, 26 |
| 2 | 1, 2, 3, 4, 8, 9, 11, 12, 21 |
| 3 | 1, 2, 3, 4, 5, 6z, 8, 9, 10, 11, 13z, 15 |
| A | 4, 5a, 5b, 5c, 5d, 5e, 7, 8a, 10, 11, 12, 14, 15, 16, 17 |
| B | 2, 4, 6, and the foreign account and trust flags 7a and 8 |
| D | 6, 7, 12, 13, 14, 15, 16, 18, 19, 21, plus next-year carryover when printed |
| E | page 1: 3, 4, 20, 21, 26. Page 2 per entity: the five line 28 columns. Totals 29a, 29b, 30, 31, 32, 37, 41 |
| SE | 4c, 12, 13 |

**Schedule K-1 (1065).** Parts I and II: partnership name, EIN last four, tax
year beginning and ending, PTP flag, general or limited, domestic or foreign,
profit, loss and capital share percents beginning and ending, and the three
liability lines. Part L capital account: beginning capital, contributed,
current year net income or loss, other increase or decrease, withdrawals and
distributions, ending capital. Part III boxes 1, 2, 3, 4a, 4b, 4c, 5, 6a, 6b,
7, 8, 9a, 9b, 9c, 10, and by code 11, 12, 13, 14, 15, 17, 18, 19, 20 including
20Z. Flags: amended, final, K-3 attached. A state attachment is a separate form
instance with the same counterparty and a state jurisdiction.

| Form | Captured |
| --- | --- |
| W-2 | boxes 1, 2, 3, 4, 5, 6, the box 12 code and amount pairs, 16, 17, employer, state |
| 1099-INT | 1, 3, 4, 8, 11, payer |
| 1099-DIV | 1a, 1b, 2a, 3, 4, 5, 7, payer |
| 1099-B, composite brokerage | per term and covered status: proceeds, cost basis, wash sale disallowed, withheld |
| 1099-MISC, NEC | NEC 1; MISC 1, 2, 3, 4 |
| 1099-R | 1, 2a, 4, distribution code, payer |
| 1099-G | 1, 2, 4 |
| 1098 | 1, 5, 10 |
| HSA: 1099-SA, 5498-SA, 8889 | distributions, contributions, 8889 lines 13 and 17b |
| 5498 | contributions, rollover, fair market value |
| 8949 | per box code: proceeds, cost, adjustment, gain or loss. Detail rows skipped |
| 8995, 8995-A | QBI component totals, QBI deduction |
| 8960, 8959 | net investment income and its tax; additional Medicare tax |
| 1116, 6251, 8582, 4562 | per category foreign taxes and credit; AMTI, tentative minimum tax, AMT; passive loss allowed; section 179 and total depreciation |
| 8879 | tax year, AGI, total tax, refund or owed, signature date |
| 1040-ES, 4868 | quarter, amount, date paid; estimate of total tax, payments, amount paid with extension |
| State return | state AGI, taxable income, tax, withholding, estimated payments, refund or owed |
| Notice, property tax statement | notice number or jurisdiction, tax year, amount, deadline or due dates |
| Charitable receipt | organization, date, amount, goods-provided statement present |

Preparer invoices and engagement letters reuse the existing `invoice` and
`letter_or_notice` kinds in `packages/kith-store/src/extraction/seed.ts`.

Decision, owner, 2026-09-19: the owner has only ever filed in one state, and
it levies no broad income tax, only a capital gains excise on high earners.
That return is short, but it gets full catalog treatment like federal, not
the identity-plus-six-totals fallback a state would otherwise get. The
fallback stays the rule for any other state that appears later.

## 2. Aggregatable projections: a general pattern

Work item the owner approved, 2026-09-19, and not tax-only: every extraction
observation hangs off `other:document`, `placeholderEntityId` in
`packages/kith-store/src/extraction/model.ts`, because a document usually
describes no single named entity. That is fine for storing an observation and
citing its evidence, and it is what breaks aggregation. `validateRecordQuery`
in `packages/kith-store/src/records/query.ts` requires an `entityId` for
`latest_observation` and `list_events`, and exactly one `entityId` or
`sourceAccountId` for `sum_money`: filters that carry no information when
every row points at the same placeholder. `sum_money` also has no group-by,
so "AGI by year for 15 years" is 15 calls and "K-1 income by fund by year" is
not expressible at all.

The fix is not per-domain. Any domain that needs aggregation gets a flat,
typed projection table, written inside the same transaction as `store()` in
`extraction/model.ts` so no reader ever sees the gated statements and the
projection disagree. The gated statements stay the source of truth: they
carry the evidence span, survive re-extraction, and are what `corrections.ts`
writes through. The projection is derived, never edited directly, and always
rebuildable: a `rebuild-from-statements` command re-derives one domain's
projection table from the current gated statements and evidence, so a schema
fix or a new semantic key never requires re-running extraction to get history
right.

Order of adoption: `tax_facts` first (section 3), because it is the domain
already on the table. Next, receipts and invoices line totals: the same
placeholder-entity problem stops "total spent at each vendor this year" from
being one query. Then investment-document facts, which
`2026-09-19-investment-document-matching.md` scores and cites but never
aggregates. Each projection is its own table with its own semantic keys; this
section is the shape they share, not a shared table.

A projection table earns four things a raw-statement query cannot give
cheaply: a stable `semantic_key` per fact independent of a form's line
numbering, one row per fact so `GROUP BY` works, a citation back to the
statement and evidence span that produced it, and an `authoritative` flag
where a domain has the idea of a superseding version (an amended tax return,
a corrected invoice). A domain with none of that (a single flag, a one-off
count) does not need a projection and should keep using `sum_money` and
friends.

## 3. Storage: tax_facts as the first projection

Chosen: **(c), both, with the table as a projection**: the pattern section 2
describes, applied here. Option (a) alone (gated statements only) fails the
owner's goal for the reasons section 2 gives: the placeholder entity and the
missing group-by. Option (b) alone (a bespoke table, no gated statements)
would discard the evidence, correction and re-extraction machinery that
already works. `tax_facts` is derived from the gated statements inside the
same transaction as `store()`, and is rebuildable by the command section 2
introduces.

**Migration 028** adds `kith.tax_returns` (space, tax_year, jurisdiction,
filing_kind, filing_version, authoritative, supersedes_return_id, filed_date),
`kith.tax_facts`, `kith.tax_return_documents`, a `line_refs jsonb` column on
`document_type_fields`, and migration 023 change triggers on the new tables.

`kith.tax_facts`: `id`, `space_id`, `created_at`, `return_id`, `tax_year`,
`jurisdiction`, `form`, `form_instance`, `counterparty_as_written`,
`semantic_key`, `line_label`, `line_ref`, `amount numeric`, `currency`,
`source_item_id`, `evidence_span_id`, `state` in (`verified`, `unverified`,
`disputed`), `corrected`, `authoritative`. `amount` repeats migration 001's
money guards verbatim, as `investment_entries.amount` does in migration 022.
`authoritative` is denormalized from `tax_returns` in the same transaction so
the owner's queries stay single-table. Unique on
`(space_id, return_id, form, form_instance, semantic_key)`; indexes on
`(space_id, tax_year, semantic_key) WHERE authoritative` and
`(space_id, form, semantic_key, tax_year)`.

```sql
-- AGI and total tax by year
SELECT tax_year,
       max(amount) FILTER (WHERE semantic_key = 'agi')       AS agi,
       max(amount) FILTER (WHERE semantic_key = 'total_tax') AS total_tax
  FROM kith.tax_facts
 WHERE space_id = $1 AND jurisdiction = 'US' AND authoritative
 GROUP BY tax_year ORDER BY tax_year;

-- K-1 ordinary business income by fund by year
SELECT tax_year, counterparty_as_written AS fund, sum(amount) AS ordinary_income
  FROM kith.tax_facts
 WHERE space_id = $1 AND form = 'schedule_k1_1065' AND authoritative
   AND semantic_key = 'k1_ordinary_business_income'
 GROUP BY tax_year, fund ORDER BY tax_year, fund;

-- effective federal rate by year
SELECT tax_year, round(total_tax / nullif(agi, 0) * 100, 2) AS effective_rate_pct
  FROM (SELECT tax_year,
               max(amount) FILTER (WHERE semantic_key = 'total_tax') AS total_tax,
               max(amount) FILTER (WHERE semantic_key = 'agi')       AS agi
          FROM kith.tax_facts
         WHERE space_id = $1 AND jurisdiction = 'US' AND authoritative
           AND state <> 'disputed'
         GROUP BY tax_year) t
 ORDER BY tax_year;
```

## 4. Kinds as data

One `document_types` row per form family, not per year: about 30 rows. Fields
are semantic keys, which already satisfy `isObservationFieldName` in `gate.ts`.
Year variation lives in the new `line_refs` jsonb on the field row:

```json
{"2024": {"line": "11", "label": "Adjusted gross income"},
 "2017": {"line": "37", "label": "Adjusted gross income"}}
```

Rows are generated by extending `seedDocumentTypes` with a checked-in catalog,
`packages/kith-store/src/extraction/taxCatalog.ts`, built from public blank IRS
forms and containing no personal data. The seeder stays idempotent by (space,
kind), so an owner edit in the types screen is never walked back. Thirty kinds
at about 15 fields is roughly 450 field rows, all generated, none hand-written,
all editable afterwards from the existing screen.

## 5. Long, multi-form documents

| Step | How | Tier |
| --- | --- | --- |
| Classify pages | Regex over page text for the printed form title, the OMB number and "Attachment Sequence No.", which appear on nearly every page of a filed return | code |
| Classify residue | Unlabelled pages go to one batched call, 20 page headers per call | 0 |
| Segment | Consecutive pages sharing (form, instance discriminator) become one form instance. The discriminator is the counterparty on a K-1 or Schedule E row, the property on Schedule E page 1, the category on 1116 | code |
| Extract | One call per form instance with only that form's fields and that year's `line_refs`. The bounds in `model.ts` (12 pages, 60k chars, 96 statements) are unchanged: an instance is one to six pages | 0, or 1 for K-1 and composite 1099 |
| Reassemble | Instances write into one `tax_returns` row keyed by (space, tax_year, jurisdiction, filing_version) | code |

Pipeline constants that must move together:

| Constant | File | Today | Proposed |
| --- | --- | --- | --- |
| `MAX_PARSED_TEXT_PAGES` | `packages/kith-store/src/provenance/representations.ts:25` | 64 | 400 |
| `MAX_PAGES` | `packages/kith-store/src/provenance/parsedStaging.ts:128` | 64 | 400 |
| `maxConversionPages`, `maxPages` | `packages/pipeline/src/parserProcess.ts` | 64 | 400 |
| `actualPageCount` bound | `packages/pipeline/src/transport.ts:1176` | 64 | 400 |
| `pageCount` bound | `packages/pipeline/src/archiveCatalog.ts:885` | 64 | 400 |
| mapping page bound | `packages/pipeline/src/parsedBundleMapping.ts:389` | 64 | 400 |
| `MAX_DISCOVERED_PDF_BYTES` | `packages/pipeline/src/filesystem.ts:25` | 16 MB | 64 MB |
| `maxInputBytes` | `packages/pipeline/src/parserProcess.ts` | 16 MB | 64 MB |

These are code constants, not schema checks. The 7 files over 200 pages fit
inside 400 with headroom.

Page text alone suffices for 1040 and its schedules, which print
"11 Adjusted gross income . . . 123,456" as a line. Table structure is needed
for composite brokerage 1099s, 8949 summary blocks and K-1 state schedules; the
parser already has a table-structure path (`tableStructureBypass` in
`packages/pipeline/src/config.ts`), so that is configuration, not new code.

A 200-page return is roughly 130k tokens of page text, about 30 form instances,
and about 120k prompt tokens across those calls: roughly 4 cents at `gpt-4o-mini`
prices. The corpus is about 7,300 PDF pages, so a full pass costs single-digit
dollars at tier 0, and under 25 dollars if every K-1 and composite statement
escalates to tier 1. Parse time dominates: about 3 to 7 minutes per 200-page
document plus about 5 minutes of extraction calls, and a few agent hours for the
whole corpus.

## 6. Tax-specific gates

These sit on top of `checkValue` in `gate.ts`. Tolerance is zero everywhere: a
US return prints whole dollars, so a near miss is a misread, not rounding.

| Gate | Failure action |
| --- | --- |
| The quote contains both the line reference and the amount | Block storage. New correction reason `line_ref_not_in_quote` |
| Within-form identity: a total equals the sum of its components, checked only when every component was captured | Store all, set the total's `state` to `disputed`, open an attention item |
| Cross-form carries: Schedule D 16 to 1040 7, Schedule 1 10 to 1040 8, Schedule 1 26 to 1040 10, Schedule 2 3 to 1040 17, Schedule 2 21 to 1040 23, Schedule 3 8 to 1040 20, Schedule SE 12 to Schedule 2 4, Schedule A 17 to 1040 12, Schedule E 41 to Schedule 1 5 | Both sides captured and disagreeing: both `disputed`, attention item. One side missing: no check and no alarm |
| Cross-document ties: W-2 box 1 sum to 1040 1a, K-1 boxes to Schedule E page 2, 1099-INT and DIV to Schedule B | Supporting sum below the return line is a missing-document attention item, not a dispute. Supporting sum above the return line is a real contradiction: both `disputed` |
| Year over year: capital loss carryover, prior-year overpayment applied | Checked only when both years are filed and authoritative. A mismatch opens an attention item and never blocks |

The false-alarm control is one rule said three ways. A check runs only when
every input it names is present and `verified`. A shortfall a missing document
would explain becomes a missing-document item rather than a dispute. A form the
catalog does not cover produces no identities at all.

## 7. Draft, filed and amended

| Signal | Reads as |
| --- | --- |
| "DO NOT FILE" or "DRAFT" watermark text, no signature date | draft |
| A matching 8879 with the same AGI, total tax and refund or owed | filed |
| An e-file submission id or acceptance page | filed |
| Form 1040-X present | amended |

One `tax_returns` row per filing. The authoritative row for a (space, tax_year,
jurisdiction) is the amended filing when one exists, otherwise the filed one,
otherwise none. A draft stores with `authoritative = false`, so its numbers
never reach the default queries. An amendment sets `supersedes_return_id` on
itself and clears `authoritative` on the row it supersedes. Nothing is deleted
and the year's history is one query away.

Decision, owner, 2026-09-19: the owner believes no draft return exists in his
records, but a draft is stored the same as any other filing rather than
dropped: "I don't think one exists" is not "none exists." If one is found it
is not just quietly stored: it opens a quiet queue item
(`draft_return_found`), the same low-noise handling
`2026-09-19-investment-document-matching.md` section 4 gives a missing
document, so the owner learns about it without the alerting machinery
treating it as urgent.

Duplicates collapse on the fact set, not the file. A second document whose
`(form, form_instance, semantic_key, amount)` tuples all match an existing
filing adds a `tax_return_documents` row and no facts. A document that agrees on
identity but disagrees on an amount is not a duplicate: it becomes a new
`filing_version` and an attention item, because two copies of one return with
different numbers is the case the owner must see.

## 8. Sensitivity

Work item the owner approved, 2026-09-19, and its own prerequisite slice: it
shipped in PR #319 (migration `032_sensitivity.sql`) before any tax PDF is
ingested, not after. The rest of this section originally proposed a
never-store-identifiers gate, masking, redaction at the MCP read boundary and
an audit table. The owner reviewed that draft and rejected it, in these
words: "This is my personal data that I personally am accessing. Why
wouldn't I be allowed to view my tax information? Or SSN for that matter? If
I forget my wife's SSN and I need it, why shouldn't I be allowed to ask the
agent to retrieve it for me?" What follows describes what actually shipped.

**Sensitivity as a label.** Three levels, `normal`, `sensitive` and
`restricted`, not the two (`low`/`high`) originally proposed here. A
`sensitivity` column on `kith.document_types` (per kind) and on
`document_type_fields` (per field), plus a nullable owner override on
`source_items` and `source_roots` that can raise, never lower, a document's
effective level. The effective level is the maximum of kind, item override
and root override. `schedule_k1` is seeded `restricted`; the other financial
and medical kinds so far are seeded `sensitive`. No W-2 or 1099 kind exists
in the seed yet; when this plan's own extraction work adds one, give it a
level the same way. A label restricts nothing by itself.

**Never extracted, masking and redaction at the boundary were all removed.**
This section originally specified a `containsRestrictedIdentifier` gate
refusing SSNs, routing and account numbers, and dependent names at capture;
EIN and identifier masking to last four; and stripping identifiers from any
text an MCP tool or search snippet returns. None of that shipped. Extraction
stores an identifier exactly as the document states it. `get_document`,
search results and every other read return values in full, whatever the
caller's ceiling. The only place an identifier is ever altered is a scrubber
over logs, error text, `deferred_work.last_error` and outbound alerts
(`packages/kith-store/src/sensitivity/identifiers.ts`, `sinks.ts`). It never
touches stored data or a tool result.

**A per-key ceiling that filters, not a refusal.** `api_keys.max_sensitivity`
defaults to `restricted`, meaning everything, no withholding, for every key
and OAuth grant including the owner's own. Only the owner can lower a
particular credential's ceiling, and only for that one connection. A read
whose target exceeds the ceiling is filtered out of the result and counted,
not refused outright as this section originally proposed. The filter reaches
`search_documents`, `get_document`, `list_inventory`, `list_review_queue`
and the `query_records` aggregations. It does not reach thoughts, facts,
investments, sources or stats. Whether `query_tax_facts` (section 9, not yet
built) needs its own ceiling check, or reads through one of the functions
above and inherits theirs, is open; confirm against
`packages/kith-store/src/sensitivity/model.ts` when building slice 4.

**No audit table.** The audit line this section proposed was not built and
none is planned. Nothing records who read a restricted document or when.

**Deliberately not built**, for reasons unchanged from the earlier draft: no
per-field redaction inside a returned document's own text, no encryption at
rest beyond what the database already provides, no approval workflow, no
retention or expiry policy on anything. Tax documents live in the owner's
personal space: no new space, permission model or route, only the label
columns, the two sensitivity views and the ceiling above.

## 9. MCP and UI

One new read tool, `query_tax_facts`, registered in
`apps/web/src/lib/mcp/tools.ts` and annotated `readOnly` in `tool-policy.ts`.
Arguments: `spaceIds`, `years`, `jurisdiction`, `forms`, `semanticKeys`, and
`groupBy` in (`year`, `form`, `counterparty`). It answers "what was my AGI each
year" and "how much state tax over five years" in one call each, with citations.
Every result carries its `state` (`verified`, `unverified`, `disputed`); see
the Decisions table below on why hiding that would be its own silent failure.

"Which K-1s am I still missing for 2025" is a pull-only checklist question,
answered by `list_missing_k1s` in
`docs/plans/2026-09-19-investment-document-matching.md` (section 4, "Missing
K-1s: a checklist, not a detector"), never an alert, never a queue row, the
same low-noise principle this design applies to its own missing checklist
below. `identity_mismatch` and `carryover_mismatch` findings from this design
still go to `kith.corrections`, which already has the shape and the screen; no
second queue is added.

Taxes screen, in the admin house style: white, gray and blue, Inter, compact
sortable tables, kebab menus, square tags, tooltips, no prose.

| Panel | Shows |
| --- | --- |
| Year by form matrix | Rows are years, columns are form families, a cell is the instance count with a state tag |
| Return summary | One year's captured totals with printed line references, each linking to its citation |
| Missing checklist | Pull-only, on request, same principle as the K-1 checklist above: a form family present in at least two of the last three years and absent this year is listed. Never an alert, never a queue row |

## 10. Build order

Slice 0 is a hard prerequisite: it ships and is verified before any tax PDF
is ingested, real or synthetic-in-production. Slices 1 onward assume it is
already live.

| Slice | Hours | Second-model review |
| --- | --- | --- |
| 0. Sensitivity: label columns and the two views, per-key ceiling. Shipped in PR #319, scoped down from the original proposal (section 8) | done | Yes: gates what every later slice can read |
| 1. Catalog, seeder extension, migration 028 | 5 | Yes: schema and financial numbers |
| 2. Page classification and segmentation, deterministic first | 5 | No |
| 3. Raise the eight pipeline constants together, re-parse check | 4 | No |
| 4. Per-form-instance extraction, the `tax_facts` projection and its rebuild command | 6 | Yes |
| 5. Tax gates: line reference in quote, within-form identity, cross-form carries | 5 | Yes |
| 6. Return identity: draft, filed, amended, duplicate collapse | 4 | Yes |
| 7. Cross-document ties and carryovers, emitting attention items | 5 | Yes |
| 8. `query_tax_facts` and the attention-queue classes | 4 | Yes: MCP exposure |
| 9. Taxes screen | 6 | No |

Every slice is testable against synthetic fixtures: public blank IRS forms
filled with invented numbers, checked into the repository. No real return is
needed to prove any of it, and none is committed.

## Current implementation (PR #357, not deployed until merged)

The first bounded federal-return pass is implemented through the existing
typed document extraction path. New spaces receive the `tax_return_1040`
catalog at seed time, and extraction adds that catalog to existing spaces
without replacing an owner-edited version. When a real Form 1040 heading
appears near the front, the runner sends the contiguous return forms and
Schedules 1, 2, 3, A, D and E to the existing model request. It preserves the
selected source pages for evidence spans, and stops before a page that
identifies itself as a K-1, W-2, 1099 or brokerage attachment. A reference to
one of those forms on a 1040 or schedule page does not end the pass.

Accepted totals remain ordinary cited `document_statement` observations, so
the existing document reader and `query_records` can retrieve them. The
runner records a real page or character bound as missing coverage, while an
intentional attachment boundary does not create a false truncation warning.
The dedicated `tax_facts` projection and `query_tax_facts` remain future
slices.

Measuring the first real run:

| Measure | Target |
| --- | --- |
| Per-form capture rate | Captured keys over catalog keys for that form and year. Under 80 percent means the catalog or the classifier is wrong |
| Classification accuracy | Hand-check three returns page by page. Under 95 percent blocks slice 4 |
| Identity pass rate | Identities that ran and passed, over identities that ran |
| Corrections per return | Under 5. Over 10 means the queue is unusable and the cause is fixed before the next batch |
| Cost and coverage | `document_extractions.pages_read` against `pages_total`, and spend per return |

## 11. Decisions (owner, 2026-09-19)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Which state returns get a full catalog? | Federal in full. The owner has filed in exactly one state, income-tax-free with a capital gains excise on high earners; that state gets full treatment too, not the identity-plus-six-totals fallback (section 1). Any other state that appears later still gets the fallback |
| 2 | How far back does the first run go? | 2018 onward first, where catalog coverage is best, then backfill 2011 to 2017 at a lower capture rate |
| 3 | Does MCP return `unverified` and `disputed` facts? | Yes, always with their state attached and labeled. Hiding them is its own silent failure |
| 4 | After an amendment, is the year's authoritative answer the amended numbers or the original? | The amended filing is authoritative. The original stays readable as superseded |
| 5 | Is a draft return worth storing? | Yes, with `authoritative = false`. The owner believes none exists, but if one is found it is surfaced as a quiet queue item, not just stored silently (section 7) |
| 6 | Missing-document checklist noise? | Same low-noise principle as the investment-matching design: pull-only, never an alert or a queue item (section 9, "Missing checklist" and "Which K-1s") |
| 7 | Aggregatable projections work item | Approved as a general pattern, not tax-only. `tax_facts` first, then receipts/invoices line totals, then investment-document facts, each a flat projection table rebuildable from the gated statements (section 2) |
| 8 | Sensitivity work item | Approved as its own prerequisite slice, before any tax PDF is ingested. Shipped in PR #319 as sensitivity levels as data and a per-key ceiling only; masking, MCP and search redaction, and an audit line were proposed here and were rejected by the owner and not built (section 8, build order slice 0) |
