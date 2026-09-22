# Simplification and live feeds

Date: 2026-09-22. Status: adopted direction after the owner's efficiency review.

## Why

By 2026-09-22 the repository held about 214,000 source lines, 42 migrations
and 51 plans. About 87,000 of those lines are ingestion machinery (durable
journal, scan protocol, leases, attempt budgets, goals, replay) serving a corpus
of a few hundred files. The last orchestrator session ran 29 hours and shipped
no user-visible change. The owner's priority is an accurate, current view of
finances and health for one household. Publishing the tool is second.

## Decisions

| Topic | Decision |
| --- | --- |
| Current financial values | Come from a daily aggregator feed (Plaid), not from PDF statement parsing. Statements remain monthly history and a cross-check. |
| Outside investments | The owner's spreadsheet stays the system of record and is imported nightly as-is. |
| Health | Structured records come from the Epic patient-facing FHIR API with refresh tokens, one authorization per family member. Provider messages are exported from MyChart on a schedule. Visit transcripts are recorded, transcribed locally and stored as documents. |
| Subject identity | Every finance and health record carries the person it belongs to from ingest. Household members never merge. |
| Document ingestion | A stateless, idempotent script replaces the durable worker: walk the source, hash each file, convert new files, extract with a model, upsert by hash into the existing document and evidence tables. Failures log and retry on the next run. |
| Existing pipeline | Frozen. `packages/pipeline`, the worker handlers in `packages/kith-store/src/workers`, and the finance projection machinery accept no new features or migrations. Deletion is a later cleanup once the replacement is proven. |
| PR 417 and PR 418 | Parked. Neither changes a number the owner looks at. |
| Review | One author. One reviewer only for money arithmetic, authentication or schema changes. The orchestrator reads the diff summary and merges on green CI. No receipts, approval files or per-release helper scripts. |
| Model tiers | Sonnet implements. Haiku runs mechanical steps. The orchestrator routes and does not re-review reviewed code. |
| Tracker | One current snapshot. Rows not touched in the last week move to parked. |

## Order of work

1. Plaid feed: link once, pull daily, show balances and holdings with an as-of date.
2. Map feed accounts onto the existing account inventory so the Institutions
   view prefers the feed value and labels its source.
3. Stateless document ingester writing into the existing tables.
4. Epic FHIR pull for the owner, then each family member.
5. MyChart message export and visit transcripts.

## Acceptance

The owner opens one page and sees every account's current value with the date
it was fetched, and every family member's recent results and visits under that
person's name. A green build or a finished parse is not acceptance.
