# UI style

The owner's rules for every screen. They are requirements, not suggestions.
The implementation lives in `apps/web/src/app/globals.css` and the shared
primitives in `apps/web/src/components/ui`. Screen components consume semantic
tokens and primitives rather than restating colors, type sizes, radii or page
widths.

## Look

| Rule     | Detail                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette  | White page and card surfaces, neutral gray for subtle surfaces, borders and table headers, and a blue action ramp for primary buttons, links, focus rings, selected states and active nav. Semantic status colors (success green, warning amber, danger red, info blue) carry their own meaning and stay separate from the action blue. Consume semantic roles so the palette can change without screen rewrites. |
| Type     | Inter for body and display roles. No Cosmica or ornamented display fonts.                                                                                                                                                                                                                                                                                                                                         |
| Scale    | 14.5px body, 15px reading text, 13.5px table data, 24px page titles and 17.835px section titles.                                                                                                                                                                                                                                                                                                                  |
| Tone     | Professional, minimal and information-dense. Controls stay compact without making their labels tiny.                                                                                                                                                                                                                                                                                                              |
| Shape    | 8px controls, 10px cards and 14px overlay panels. Tags remain compact rather than fully pill-shaped.                                                                                                                                                                                                                                                                                                              |
| Text     | No explanatory sentences in the UI. Detail goes in a hover tooltip.                                                                                                                                                                                                                                                                                                                                               |
| Tooltips | Use the shared tooltip primitive. It opens immediately on hover and keyboard focus, has a white surface with a dark gray rounded border, and stays within the viewport. Do not show an information affordance without substantive detail.                                                                                                                                                                         |

## Layout

| Role       | Width                                                  |
| ---------- | ------------------------------------------------------ |
| Page shell | 1360px maximum with a responsive 16–24px gutter.       |
| Workflow   | 1200px maximum, aligned to the page shell's left edge. |
| Feed       | 960px maximum, aligned to the page shell's left edge.  |
| Reading    | 800px maximum, aligned to the page shell's left edge.  |

Pages use a white ground. Content is grouped into white tiles with a border,
restrained shadow and consistent header/content padding. Do not wrap an
entire data-heavy screen in one oversized card.

## Headings

Use one `PageHeader` per screen. Sections use `Section` or the matching
semantic heading role. Heading levels describe document structure; visual size
comes from the shared role rather than a locally chosen utility class.

## Tables

| Rule      | Detail                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Density   | Compact rows.                                                                                                                                          |
| Columns   | Every column sortable and filterable. Drag-resizable, widths remembered per table, double-click resets.                                                |
| Search    | Full-text search as you type.                                                                                                                          |
| Wrapping  | Dates and numbers never wrap.                                                                                                                          |
| Row click | Opens the row for editing in a right-hand slide-out panel. A row that groups children expands on a click anywhere in the row.                          |
| Actions   | A kebab menu in the right-most column: Edit, Delete and whatever fits. Destructive items are red and confirm in a dialog, never a browser `confirm()`. |
| Selection | Checkbox column first, shift-click ranges, bulk actions in the toolbar with the count in the confirm.                                                  |
| Panels    | Ask before discarding unsaved edits.                                                                                                                   |

## Behavior

| Rule                      | Detail                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Reactive                  | Optimistic updates with rollback on error. Server-side changes appear live. No manual refresh. |
| Inventory over onboarding | Show what exists so gaps are visible. No wizard copy, no "planned" placeholders.               |

## Where it lives

Shared pieces are in `apps/web/src/components/ui`: `data-table.tsx` (sorting,
filters, search, resizing, row click, row actions, selection), `drawer.tsx`,
`controls.tsx`, `toast.tsx`. Reuse them. Live updates come from the change-feed
hook and TanStack Query.
