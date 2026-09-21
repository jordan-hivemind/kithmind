# UI information architecture and action workflows

Date: 2026-09-20
Status: approved direction; implementation pending

## 1. Goal

Make the application read as a personal knowledge system rather than an
operator console. The home page inventories the kinds of information Kith Mind
holds. A person can drill into each kind, understand how information enters the
system, and fix problems the system raises.

This plan replaces the navigation and screen organization in section 9 of
[`2026-09-18-admin-panel-and-ingestion.md`](2026-09-18-admin-panel-and-ingestion.md).
It does not change the underlying authorization, source, coverage, finance, or
space models.

## 2. Evidence and limits

The plan is based on the current components and three owner-provided
screenshots of Coverage, Institutions, and Needs Attention. The screenshots
show these concrete failures:

| Screen | Observed problem |
| --- | --- |
| Coverage | Operational fields dominate the inventory. Status, Gaps, Sources, and Dates do not tell the owner what to do. Search and filtering add controls to a fixed eight-row list. |
| Institutions | Stale dates are placed inside Current value, so values do not align. Dense numeric and date columns are hard to scan. |
| Needs Attention | Long values overlap adjacent columns. The only available outcomes defer or dismiss work rather than resolve it. |

The standalone host could not attach to the live browser pane. The implementing
agent must inspect every affected screen in the live app before editing and
must complete the browser verification in section 14. Screenshots alone do not
establish keyboard behavior, focus order, tooltip accessibility, responsive
reflow, or screen-reader names.

## 3. Product language

Use these labels consistently in navigation, headings, links, empty states, and
tests.

| Current label | New label | Meaning |
| --- | --- | --- |
| Coverage | Your Data | Inventory of the information Kith Mind holds |
| brokerage | Investment Accounts | Accounts held at financial institutions |
| outside investments | Private Investments | Investments tracked outside those accounts |
| notes and facts | Thoughts & Facts | User-captured memory |
| Health | System Health | Operational checks, not medical history |
| Sources | Data Sources | Connections and locations from which data is ingested |
| Default Write Destination | Where new items are saved | Default space for captures and writes |
| Activity From | First Record | Earliest dated record for an account |
| Activity To | Latest Record | Latest dated record for an account |
| Attention | Needs Attention | Problems the owner can understand and act on |

Capitalize every displayed data-area name. Preserve normalized lowercase
values in storage and contracts.

## 4. Navigation and routes

The primary navigation is:

1. Home
2. Thoughts & Facts
3. Settings

Apply these route behaviors:

| Route | Behavior |
| --- | --- |
| `/` | Render Your Data, using the current coverage inventory as its data source. |
| `/browse` | Render the combined Thoughts & Facts experience. |
| `/settings` | Render the reorganized settings sections. |
| `/admin/coverage` | Redirect to `/`. |
| `/admin/institutions` | Remain as the Investment Accounts drilldown. |
| `/admin/investments` | Remain as the Private Investments drilldown. |
| `/admin/sources` | Remain as Data Sources, linked from Settings. |
| `/admin/attention` | Remain as Needs Attention, linked from Home and Settings. |
| `/admin/health` | Remain as System Health, linked from Settings. |
| `/spaces` | Remain functional but move its link under Settings, as Sharing & Access. |

Remove the Admin primary-navigation item. Owner/editor authorization remains on
every protected route. Do not weaken route gates because a link moved.

The old dashboard is not retained as another screen. Move its quick capture,
summary counts, and useful recent-item behavior into Thoughts & Facts.

## 5. Home: Your Data

Home is a small, fixed inventory. It is not an operational dashboard.

### 5.1 Rows and drilldowns

| Row | Destination |
| --- | --- |
| Investment Accounts | `/admin/institutions` |
| Private Investments | `/admin/investments` |
| Banking & Cards | A filtered data-area detail when implemented |
| Taxes | A filtered data-area detail when implemented |
| Medical | A filtered data-area detail when implemented |
| Vehicles | A filtered data-area detail when implemented |
| Home & Projects | A filtered data-area detail when implemented |
| Thoughts & Facts | `/browse` |

Rows whose detail is not implemented remain visible but do not pretend to lead
somewhere. Render a subdued `Not set up` or count-only state without a fake
link. Add a public follow-up item for the common area-detail view rather than
creating one-off placeholder routes.

### 5.2 Columns and behavior

Show:

- Data type
- Documents
- Records
- Needs attention, only when the count leads to a useful queue

Remove:

- Status
- Dates
- Sources
- Gaps
- Search
- Filters

Do not replace `0` with an Empty status badge. Right-align Documents, Records,
and Needs attention. Use tabular figures.

The current Sources value is not retained because it has inconsistent
semantics. It counts source accounts for ordinary areas, finance archive
accounts for Investment Accounts, investments for Private Investments, and
nothing comparable for Thoughts & Facts.

The current Gaps value is not retained on Home because a count without a
description or resolution path is not useful. Removing the column is not the
completion of gap work. Section 10 is a required follow-up plan with its own
acceptance criteria.

## 6. Investment Accounts

Keep institutions as expandable parent rows. Morgan Stanley, Chase, Vanguard,
and future institutions expand to show their accounts.

Remove only the caret icon. The entire parent row remains the expansion target.
Expose the expanded state with `aria-expanded`, preserve keyboard activation,
and provide a visible hover and focus treatment so the interaction does not
depend on the removed icon.

Columns:

| Column | Rule |
| --- | --- |
| Account | Institution parent or account name |
| Last 4 | Keep when available |
| Type | Keep |
| Current Value | Right-aligned accounting format; no date in the cell |
| Value Info | Fixed, narrow column containing an accessible information button |
| First Record | Right-aligned date |
| Latest Record | Right-aligned date |
| Latest Snapshot | Right-aligned date |
| Status | Keep with useful tooltip detail |

Remove Statements, Records, and Open Reviews from the table. Put statement
count, record count, value-as-of date, stale-value explanation, latest snapshot,
and status detail in the account slide-out panel.

The information icon gets its own column so it cannot disturb value alignment.
It must be a real button with an accessible name and keyboard-reachable
tooltip, not an unlabelled glyph.

Open Reviews currently counts unresolved `finance.review_items` for an account.
It includes cases where the finance importer refused to guess, such as
ambiguous dates, amounts, accounts, instruments, or unparsed documents. The
column is removed until those items have a resolvable queue. Section 11 is the
required follow-up; it may not be closed merely because the column is gone.

## 7. Private Investments

Apply these table rules:

- Render USD money in accounting format, for example `$ 100,000.22`.
- Always show two decimal places for currency.
- Right-align every money, number, and date column.
- Use tabular figures and a shared numeric-cell primitive or column metadata.
- Omit `USD`. Show a currency code only for non-USD values.
- Remove Signed from the table. Keep it in the investment detail/edit panel.
- Replace the Docs count with an accessible green check when one or more
  documents exist and an empty cell otherwise. Its accessible name is
  `Has documents`.

Investment rows may continue expanding to expose their entries if that remains
the shortest frequent path. Remove the caret icon and make the full row the
expansion target, with the same keyboard and accessibility behavior as
institution parents. Do not replace useful inline entries with a detail panel
solely to enforce visual consistency.

## 8. Data Sources

Data Sources combines the source-account inventory currently in Settings with
the watched-root inventory currently under Sources. It presents the user model
first:

- A connection identifies a provider or local host.
- A watched location tells that connection what to monitor.
- An area tells Kith Mind how to organize what it finds.
- The worker scans active watched locations and imports changes.

Do not expose `fs` as a user-facing label. Display `Local files`.

### 8.1 Inventory

Group watched locations beneath each connection without requiring a caret.
Show connection name, connection type, watched location, area, item count,
last successful read, and a plain status. Remove table search and filters.

Every connection and watched location has a rightmost kebab. Offer only actions
the server supports and name them precisely:

| Resource | Actions |
| --- | --- |
| Connection | Edit, Enable/Disable, Disconnect when implemented |
| Watched location | Edit, Pause/Resume, Delete |

`Delete` for a watched location uses the existing retire behavior. Confirm:

> Stop watching this folder? New and changed files will no longer be imported.
> Already indexed documents and records will remain available.

Do not label source-account disabling as deletion. Add dependency-aware
Disconnect as a separate backend task. Its confirmation must enumerate the
number of affected watched locations and explain whether credentials and
already indexed data remain. Do not hard-delete a source account with dependent
provenance.

Synthetic or obsolete connections, including deployment smoke fixtures, must
be removable through these ordinary actions. Do not special-case fixture names
in the UI.

### 8.2 Watch a folder flow

Replace Add Folder's implementation-language fields with four compact steps:

1. **Connection.** Choose the host or provider that can access the folder.
2. **Folder.** Prefer a folder picker or a list of worker-reported allowed
   roots. If neither exists, choose a named allowed root and enter a relative
   path. Do not accept an unexplained free-text host-root alias.
3. **Organize as.** Choose the data area. The label is `Organize as`, not
   `Area`.
4. **Review.** Show the resolved location, whether subfolders are included,
   the destination space, and what the first scan will do.

The primary action is `Start watching`. After creation, show one of:

- Waiting for worker
- Scanning
- Up to date
- Action needed
- Paused

A pending source must include a next action. Distinguish at least: no worker has
reported it, host root is unknown, path is unavailable, and scan is queued.
`Pending` alone is not acceptable.

## 9. Settings and Thoughts & Facts

### 9.1 Settings

Order sections as:

1. Account
2. Connections & Sources
3. AI Access
4. Sharing & Access
5. System & Operations

Move links to Data Sources, Spaces, Needs Attention, and System Health into the
appropriate sections.

Rename Default Write Destination to Where new items are saved. Hide the
control when only one writable space exists. When it is shown, use the compact
supporting label `New captures use this space unless another is selected.`

API Keys show Purpose, Key prefix, Access, Data access, Last used, Created, and
Status. Derive status as Active, Never used, or Inactive from revocation and
last-use data. Retain Edit and Revoke. A destructive revoke action confirms
that clients using the key will immediately stop working.

The existing key name is the user-supplied purpose. Do not claim to know the
external client using a key unless that relationship is recorded. Token or
dollar spend is out of scope until provider usage is recorded per credential.
Add it only from measured telemetry.

Replace Connect with AI Connections. Remove hard-coded references to
`flippyhead/ai-brain-plugin`, legacy Open Brain names, generic prompt
templates, and commands not supported by this deployment. Show only current
MCP endpoint and client setup information generated from application
configuration.

### 9.2 Thoughts & Facts

Combine the useful behavior of Dashboard and Browse on `/browse`:

- Quick capture
- Thoughts and Facts selector
- Search and relevant filters
- Existing summary counts, visually secondary
- Results with existing edit and delete actions

Remove Dashboard as a separate concept and page heading. Preserve optimistic
updates, rollback, and live refresh.

## 10. Required follow-up: actionable Coverage Gaps

Create a public tracker row or issue when the UI reorganization PR opens. Link
it from that PR. This work is not optional cleanup.

### 10.1 Goal

Tell the owner what evidence is missing, why the system believes it is missing,
what answer quality is affected, and what action can close or acknowledge the
gap.

### 10.2 Required design

Add a Gaps view within Needs Attention or a dedicated data-area detail. Each
item contains:

- Plain description, such as `No Morgan Stanley statements found for March
  through May 2025`
- Affected data type, source, and account when known
- Expected and observed date range
- Detection reason translated from the stored reason code
- Consequence, such as incomplete fee totals for the period
- Evidence for the expectation
- One valid action: rescan, reconnect, change expected range, mark unavailable,
  or mark not expected

Do not show an unexplained aggregate as the primary experience. Home may later
show `3 need attention` only when it links to these items.

### 10.3 Acceptance

- Every open coverage-gap reason has human-readable copy.
- Every displayed gap has at least one honest resolution or acknowledgement
  path.
- Resolving or acknowledging an item updates its stored status and audit data.
- A gap cannot disappear merely because a UI filter changed.
- Coverage-qualified answers continue to report unresolved gaps through the
  query contract.
- Tests cover authorization, resolution, acknowledgement, and reappearance
  after a later reconciliation detects the condition again.

## 11. Required follow-up: actionable Finance Reviews

Create a separate public tracker row or issue when the UI reorganization PR
opens. Link it from that PR. Because resolution can alter financial identity or
values, this is tier 2 and requires the independent review mandated by the
repository guide.

### 11.1 Goal

Present finance archive review items in the unified Needs Attention queue and
let the owner make the decision the importer deliberately refused to guess.

### 11.2 Required design

Map each finance review kind and reason code to:

- Plain problem statement
- Institution, account, and document context
- Original value and candidate interpretations when available
- Source evidence
- A type-specific resolution control
- `Not enough information` and `Not needed` outcomes where honest

Resolution examples include selecting an account, confirming an instrument,
entering an exact date or amount, retrying an unparsed document, or accepting a
specific candidate. A general-purpose free-text correction is not sufficient.

### 11.3 Acceptance

- Every review kind is either resolvable, explicitly informational and omitted
  from the action queue, or marked `Resolution not yet supported`.
- Resolutions write through finance archive APIs and preserve the original
  review record and audit history.
- Financial totals are recomputed by authoritative archive code, never in the
  browser.
- The account drawer may show a linked unresolved-review count only after that
  link opens the filtered queue.
- Tests cover authorization, invalid candidates, idempotent resolution, totals
  after resolution, and audit retention.
- A second model reviews the API, archive mutation, and total-changing code
  before merge.

## 12. Shared table and accessibility requirements

Update shared table primitives only when the behavior is reusable and backward
compatible. Only one open PR may modify `apps/web/src/components/ui/*`.

- Money, number, and date columns are right-aligned through column metadata or
  shared cell primitives.
- Money uses exact decimal strings. Do not convert authoritative decimal
  strings to JavaScript numbers.
- Dates and numbers never wrap.
- Row expansion without a caret remains keyboard operable with Enter and
  Space, exposes `aria-expanded`, and has a visible focus indicator.
- Information icons are labelled buttons with hover and focus behavior.
- Tooltips are supplementary. Essential meaning remains available through the
  row or drawer.
- Destructive actions use an application dialog with consequence-specific
  text. Do not use browser `confirm()`.
- Verify at desktop width, 200% zoom, and a narrow mobile viewport.

## 13. Delivery plan

### PR 1: UI reorganization

Recommended owner: Luna, tier 0 for mechanical edits or tier 1 if available.
This is suitable for Luna when handled as the bounded tasks below, with a tier
1 or orchestrator review of the integrated result.

1. Add shared alignment and accounting-format support with focused tests.
2. Replace primary navigation and route `/` to Your Data.
3. Implement the Home inventory and drilldown links.
4. Update Investment Accounts while preserving row expansion and removing
   only the caret.
5. Update Private Investments formatting and document indicator.
6. Consolidate Data Sources and replace Add Folder with Watch a folder.
7. Reorganize Settings and move Spaces/System Health links.
8. Combine Dashboard and Browse into Thoughts & Facts.
9. Reflow Needs Attention so text does not overlap. Add an explicit
   `Resolution not yet supported` state where a correction workflow is absent;
   do not invent financial resolution writes in this PR.
10. Open and link the two required follow-up issues or tracker rows from
    sections 10 and 11.

Expected files include the authenticated navigation and routes, admin layout,
coverage, institution, investment, source, attention, dashboard, browse, and
settings components; their data loaders; shared format helpers; and focused
tests. The implementing agent must list exact files in the draft PR before
editing, per the parallel-lane rules.

### PR 2: Coverage Gaps workflow

Recommended owner: Terra, tier 1. Implement section 10. Use synthetic fixtures.
Update the public architecture or ingestion plan if resolution changes coverage
semantics.

### PR 3: Finance Reviews workflow

Recommended owner: Sol, tier 2, plus independent second-model review. Implement
section 11. This PR may cross finance archive and API boundaries and must not be
assigned to a side lane that is prohibited from those files.

## 14. Verification

Each code PR runs:

```sh
pnpm lint
pnpm check-types
pnpm test:once
pnpm build
```

PR 1 also verifies in the browser:

1. Home inventories all eight data types and opens implemented drilldowns.
2. Investment Accounts expands an institution by row click with no caret and
   opens account details without accidental expansion conflicts.
3. Currency, numeric, and date columns align across representative values.
4. Private Investments shows accounting-formatted USD and non-USD labels only
   where needed.
5. Every Data Sources row has the correct kebab actions and every delete or
   disconnect action explains its exact retention behavior.
6. A pending watched location shows a cause and next action.
7. Thoughts & Facts supports capture, search, edit, and delete from one page.
8. Settings contains no obsolete repository or Open Brain connection text.
9. Needs Attention has no overlapping fields at desktop, narrow viewport, or
   200% zoom.
10. Keyboard-only use can expand groups, open drawers and menus, dismiss
    dialogs, and return focus to the initiating control.

Use synthetic fixtures for screenshots and tests. Do not expose owner document
text, paths, accounts, or database values.

## 15. Completion

The UI reorganization is complete when PR 1 is merged with all checks green,
the browser verification passes, and the two follow-up work items are public,
linked, scoped, and owned. Coverage Gaps and Finance Reviews are complete only
when their separate acceptance criteria pass. Removing their old table columns
does not satisfy those tasks.
