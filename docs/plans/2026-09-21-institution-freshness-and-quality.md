# Institution statement freshness and data quality

A current, complete statement can fail historical trade-quantity reconciliation.
The Institutions table currently calls that account stale because its snapshot
eligibility date includes reconciliation gates. This also obscures the difference
between an overdue statement, incomplete holdings, and source-stated unavailable
prices. Bulk trade histories may intentionally remain metadata-only, so importing
all historical activity cannot be a prerequisite for reporting statement age.

## Bounded change

Add an optional, non-monetary latest holdings observation assessment to account
inventory. It records the actual observed date, source completeness, valuation
availability and reconciliation outcome. Derive it from the same contributing
sources and current-generation proofs used by existing inventory eligibility.
An observed date alone never proves completeness. Explicit source-stated zero
holdings remain distinct from missing or unparsed holdings.

Keep financial snapshot selection and aggregation eligibility intact. The new
assessment is diagnostic metadata, not authority to publish a total or clear a
review. Partial or unpriced holdings remain incomplete. Legacy clients and
inventory rows without the optional assessment retain their existing behavior.

Institutions combines observed statement cadence and this assessment. Overdue
statements remain stale. Timely observations with incomplete holdings, missing
valuation or failed/pending reconciliation show needs-review status with the
specific reason. Only timely complete and fully valued holdings with no blocking
quality issue show fresh. Empty, inactive and balance-only semantics remain.
Do not replace a current-value amount with an inferred number.

Display the observed holdings date clearly and retain the eligible snapshot date
in diagnostic details when different. Group rows reflect unresolved child quality;
a current child must not hide another child's overdue or incomplete data.

## Ownership and verification

Root owns this bounded contract/query/UI slice. The query change follows PR406's
review-attribution correction; the additions-only publisher owns no reader edits.
Coordinate the advertised MCP versions with the targeted-tax release.

Use synthetic cases for overdue data, complete current holdings with historical
reconciliation failure, current unpriced/partial sources, explicit zero, mixed
source completeness, legacy absence and group summaries. Verify inventory,
snapshot and aggregate parity: diagnostics may become clearer while withheld
financial results remain withheld. Run focused affected checks, one independent
source review and the final stable-head CI gate. Live acceptance reports actual
account states and unresolved causes; removing a stale label is not evidence that
an unavailable price or missing transaction has been repaired.
