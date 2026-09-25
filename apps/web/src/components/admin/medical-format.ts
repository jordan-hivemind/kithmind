// Pure display helpers for the Health Records page
// (`medical-records-table.tsx`, `medical-drawers.tsx`): what a lab flag's
// tag color should be, what a source's pull status reads as, and when a
// truncated summary is worth a tooltip. Split out and exported, rather than
// written inline, the same way `institutions-value-info.ts` keeps
// `institutions-table.tsx`'s own display decisions testable without a DOM.

import { tableDateTime } from "@/lib/kith/format";

/**
 * A lab or vitals flag's tag tone. Null for no flag at all (nothing to
 * render); `"N"` (explicitly normal) reads as neutral; anything else --
 * `"H"`, `"L"`, `"A"`, Epic's own abbreviations -- reads as an abnormal
 * result and gets the warning tone.
 */
export function flagTone(flag: string | null): "warn" | "neutral" | null {
  if (flag === null || flag === "") return null;
  return flag.toUpperCase() === "N" ? "neutral" : "warn";
}

/** The header's per-source line: when a source has never completed a pull,
 * say so rather than rendering an empty date. */
export function pulledStatusText(lastPulledAt: number | null): string {
  return lastPulledAt === null ? "Not yet pulled" : `Last pulled ${tableDateTime(lastPulledAt)}`;
}

/** A truncated summary's tooltip: only the full list when it actually adds
 * something the summary itself does not already say in full. */
export function truncatedDetail(summary: string, full: string): string | null {
  return summary === full ? null : full;
}
