# Tax return extraction

Date: 2026-09-19
Status: proposed. Design only.

Owner requirement, verbatim: "I'd like to be aggressive / broad about the
information we extract from the tax return and keep in Postgres. Not every line
item, but every total, so it's easy to run basic aggregations and calculations
without pulling the original documents."

This extends the typed extraction backend in
`packages/kith-store/src/extraction/`. The gate, the corrections queue and the
evidence spans are unchanged.

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

## 2. Storage

Chosen: **(c), both, with the table as a projection.**

The gated statements stay the source of truth. They carry the evidence span,
survive re-extraction, and are what `corrections.ts` writes through. The
projection is rebuilt from them inside the same transaction as `store()` in
`extraction/model.ts`, so no reader sees the two disagree.

Option (a) alone fails the owner's goal. `validateRecordQuery` in
`packages/kith-store/src/records/query.ts` requires an `entityId` for
`latest_observation` and `list_events`, and exactly one `entityId` or
`sourceAccountId` for `sum_money`. Every extraction observation hangs off the
single `other:document` placeholder entity (`placeholderEntityId` in
`model.ts`), so those filters carry no information here. `sum_money` has no
group-by either: AGI by year for 15 years is 15 calls, and K-1 income by fund by
year is not expressible. Option (b) alone would discard the evidence,
correction and re-extraction machinery that already works.

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

## 3. Kinds as data

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

## 4. Long, multi-form documents

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

## 5. Tax-specific gates

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

## 6. Draft, filed and amended

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

Duplicates collapse on the fact set, not the file. A second document whose
`(form, form_instance, semantic_key, amount)` tuples all match an existing
filing adds a `tax_return_documents` row and no facts. A document that agrees on
identity but disagrees on an amount is not a duplicate: it becomes a new
`filing_version` and an attention item, because two copies of one return with
different numbers is the case the owner must see.

## 7. Sensitivity

There is no sensitivity tier system in the code today. Space isolation
(`packages/kith-store/src/identity/spaces.ts`, `authorization.ts`) and a "last
four only" convention are what exist, and this design uses them instead of
inventing a tier scheme. `seed.ts` already models the convention with
`account_last_four` and `partnership_ein_last_four`, and `maskedLabel` in
`apps/web/src/lib/kith/institutions.ts` is the one place a web label is built.

| Item | Rule |
| --- | --- |
| SSN, ITIN, any taxpayer identifying number | Never a fact, never a semantic key |
| EIN | Last four only, as `*_ein_last_four` |
| Bank routing and account numbers (1040 lines 35b to 35d) | Never captured |
| Dependent names and SSNs | Never captured. A count of dependents is fine |
| Street addresses | Never captured. Jurisdiction and state are fine |
| Filer name | As written, as `recipient_as_written` already is |

Page text and evidence spans are stored unredacted today and this design does
not change that: the pages are the archive. The control is at the boundary. One
new pure function beside the gate, `containsRestrictedIdentifier(text)`, refuses
a statement whose value matches an SSN, EIN, routing or account pattern, and
refuses a `tax_facts` row whose quote prints one. The new MCP tool returns
amounts, semantic keys, form, line reference, year, jurisdiction, counterparty,
state and an evidence span id, and no quote text. `get_document` keeps its
existing behavior and authorization. Tax documents live in the owner's personal
space: no new tier, permission or route.

## 8. MCP and UI

One new read tool, `query_tax_facts`, registered in
`apps/web/src/lib/mcp/tools.ts` and annotated `readOnly` in `tool-policy.ts`.
Arguments: `spaceIds`, `years`, `jurisdiction`, `forms`, `semanticKeys`, and
`groupBy` in (`year`, `form`, `counterparty`). It answers "what was my AGI each
year" and "how much state tax over five years" in one call each, with citations.

"Which K-1s am I still missing for 2025" is an attention-queue question, not a
tax-facts one. The queue is being designed in parallel
(`docs/plans/2026-09-19-investment-document-matching.md`). This work writes to a
generic interface: an item is `{kind, space_id, subject, detail, opened_at,
state}` with kinds `missing_document`, `identity_mismatch` and
`carryover_mismatch`. If that plan does not land first the items go to
`kith.corrections`, which already has the shape and the screen. Either way no
second queue is added.

Taxes screen, in the admin house style: white, gray and blue, Inter, compact
sortable tables, kebab menus, square tags, tooltips, no prose.

| Panel | Shows |
| --- | --- |
| Year by form matrix | Rows are years, columns are form families, a cell is the instance count with a state tag |
| Return summary | One year's captured totals with printed line references, each linking to its citation |
| Missing checklist | A form family present in at least two of the last three years and absent this year is expected. Each gap is an attention item, not a screen-local warning |

## 9. Build order

| Slice | Hours | Second-model review |
| --- | --- | --- |
| 1. Catalog, seeder extension, migration 028 | 5 | Yes: schema and financial numbers |
| 2. Page classification and segmentation, deterministic first | 5 | No |
| 3. Raise the eight pipeline constants together, re-parse check | 4 | No |
| 4. Per-form-instance extraction and the `tax_facts` projection | 6 | Yes |
| 5. Tax gates: line reference in quote, within-form identity, cross-form carries | 5 | Yes |
| 6. Return identity: draft, filed, amended, duplicate collapse | 4 | Yes |
| 7. Cross-document ties and carryovers, emitting attention items | 5 | Yes |
| 8. `query_tax_facts` and the attention-queue classes | 4 | Yes: MCP exposure |
| 9. Taxes screen | 6 | No |

Every slice is testable against synthetic fixtures: public blank IRS forms
filled with invented numbers, checked into the repository. No real return is
needed to prove any of it, and none is committed.

Measuring the first real run:

| Measure | Target |
| --- | --- |
| Per-form capture rate | Captured keys over catalog keys for that form and year. Under 80 percent means the catalog or the classifier is wrong |
| Classification accuracy | Hand-check three returns page by page. Under 95 percent blocks slice 4 |
| Identity pass rate | Identities that ran and passed, over identities that ran |
| Corrections per return | Under 5. Over 10 means the queue is unusable and the cause is fixed before the next batch |
| Cost and coverage | `document_extractions.pages_read` against `pages_total`, and spend per return |

## 10. Open questions

| # | Question | Recommended default |
| --- | --- | --- |
| 1 | Which state returns get a full catalog? | Federal in full. Per state, identity plus the six summary totals until that state earns its own catalog |
| 2 | How far back does the first run go? | 2018 onward first, where catalog coverage is best, then backfill 2011 to 2017 at a lower capture rate |
| 3 | Does MCP return `unverified` and `disputed` facts? | Yes, always with their state attached. Hiding them is its own silent failure |
| 4 | After an amendment, is the year's authoritative answer the amended numbers or the original? | The amended filing. The original stays readable as superseded |
| 5 | Is a draft return worth storing? | Yes, with `authoritative = false`. It is free and it answers what changed before filing |
