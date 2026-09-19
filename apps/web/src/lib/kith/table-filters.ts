// The two pieces of table behaviour that are this repo's rather than TanStack
// Table's: how a search box matches a row, and what a column's filter chips
// offer.
//
// Sorting, column filtering and row expansion come from TanStack Table's own
// models, so there is nothing of ours to test there. These two are ours, they
// decide what the owner sees, and they are pure -- which is what lets them be
// tested without a DOM, since this app has no component test environment.

/** What a cell contributes to search: its rendered text, lowercased. */
export function searchableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  if (Array.isArray(value)) return value.map(searchableText).join(" ");
  if (value instanceof Date) return value.toISOString().toLowerCase();
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(searchableText)
      .join(" ");
  }
  return "";
}

/**
 * Search as you type: every whitespace-separated term must appear somewhere in
 * the row, in any cell, in any order.
 *
 * All terms rather than any, because typing more must narrow. Substring rather
 * than prefix, because the owner searches for the middle of a path as often as
 * for the start of a name.
 */
export function rowMatchesSearch(
  values: readonly unknown[],
  search: string,
): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = values.map(searchableText).join(" ");
  return terms.every((term) => haystack.includes(term));
}

export type ChipOption = { value: string; count: number };

/**
 * A column's filter chips: every distinct value it holds with how many rows
 * hold it, commonest first, then alphabetically so the order is stable when
 * counts tie. Empty cells get no chip -- "filter by nothing" is what clearing
 * the filter already does.
 */
export function columnChipOptions(values: readonly unknown[]): ChipOption[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * The chip filter itself: no selection means every row, and a selection means
 * the row's value is one of the selected ones. Multi-select rather than
 * single, because "show me folders and institutions" is one thought.
 */
export function matchesChipFilter(
  value: unknown,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  return selected.includes(String(value ?? ""));
}
