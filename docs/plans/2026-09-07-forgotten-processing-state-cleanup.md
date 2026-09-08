# Forgotten processing state cleanup

## Problem

Parsed PDF processing creates replay receipts, staging rows, and an immutable
payload manifest. The source-item forget workflow originally omitted these
three tables. Payload manifests therefore remained permanently after their
generation was deleted. Parsed stages and binary receipts had retention
deadlines, but the cleanup scheduler did not process them.

## Adopted behavior

The normal forget state machine deletes these tables by `sourceItemId` before
jobs and generations. Each invocation deletes at most 25 rows and validates
the row's space and source-account parent chain. Tombstone finalization checks
the same tables, so a direct or future caller cannot mark an item forgotten
while processing metadata remains.

The worker cleanup scheduler appends two phases under a new checkpoint layout.
Expired binary receipts are removed after their replay deadline. An expired
parsed stage is removed only when its job is coherently terminal and no
stage-bound receipt still has a live replay window. Missing jobs are treated
as ambiguous unless the source item is a valid forgotten tombstone. Other
missing or incoherent parents remain for explicit review. Payload manifests
have no age-based cleanup because an active generation uses them as its sealed
payload inventory.

An internal repair mutation accepts exactly one forgotten source-item ID. It
defaults to dry-run, reports bounded per-table counts, validates the source
account and every child parent chain, and deletes at most 25 rows per call.
It does not scan for candidates. This permits exact cleanup of already-forgotten
items without broad production deletion.

## Verification

Synthetic Convex tests cover:

- a complete forget with 26 receipts, a stage, and a manifest;
- bounded repair resumption and idempotent completion;
- default dry-run behavior and transaction rollback on an invalid child;
- isolation from another source item in the same database;
- direct finalization rejection for each residual table;
- terminal-stage retention through the latest receipt replay deadline;
- preservation of live jobs, unknown parents, and active manifests;
- scheduler checkpoint migration to the appended phase layout.

Development repair must run dry-run first against each exact synthetic
source-item ID, then repeat bounded writes to `done: true`, and finally verify
that all three indexed tables contain zero rows for that item.
