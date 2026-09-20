# UI style

The owner's rules for every screen. They are requirements, not suggestions.

## Look

| Rule | Detail |
| --- | --- |
| Palette | White, gray and blue. No khaki or cream backgrounds, no green accent. |
| Type | Inter. No ornamented or display fonts. |
| Tone | Professional and minimal. No cushioned or oversized buttons. |
| Pills | Square corners. |
| Text | No explanatory sentences in the UI. Detail goes in a hover tooltip. |

## Tables

| Rule | Detail |
| --- | --- |
| Density | Compact rows. |
| Columns | Every column sortable and filterable. Drag-resizable, widths remembered per table, double-click resets. |
| Search | Full-text search as you type. |
| Wrapping | Dates and numbers never wrap. |
| Row click | Opens the row for editing in a right-hand slide-out panel. A row that groups children expands on a click anywhere in the row. |
| Actions | A kebab menu in the right-most column: Edit, Delete and whatever fits. Destructive items are red and confirm in a dialog, never a browser `confirm()`. |
| Selection | Checkbox column first, shift-click ranges, bulk actions in the toolbar with the count in the confirm. |
| Panels | Ask before discarding unsaved edits. |

## Behavior

| Rule | Detail |
| --- | --- |
| Reactive | Optimistic updates with rollback on error. Server-side changes appear live. No manual refresh. |
| Inventory over onboarding | Show what exists so gaps are visible. No wizard copy, no "planned" placeholders. |

## Where it lives

Shared pieces are in `apps/web/src/components/ui`: `data-table.tsx` (sorting,
filters, search, resizing, row click, row actions, selection), `drawer.tsx`,
`controls.tsx`, `toast.tsx`. Reuse them. Live updates come from the change-feed
hook and TanStack Query.
