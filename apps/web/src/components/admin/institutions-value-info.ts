import { archiveDate } from "@/lib/kith/format";
import type { InstitutionRow } from "@/lib/kith/institutions";

/** Only render the compact affordance when it can add information the row
 * itself does not already state. A date is useful, but so are value staleness
 * and an inactive account when the archive did not disclose a date. */
export function valueInformationDetail(
  row: Pick<
    InstitutionRow,
    "currentValueAsOf" | "currentValueStale" | "status"
  >,
): string | null {
  const detail = [
    row.currentValueAsOf === null
      ? null
      : `As of ${archiveDate(row.currentValueAsOf)}`,
    row.currentValueStale ? "Reported value is stale" : null,
    row.status === "inactive" ? "Account is inactive" : null,
  ].filter((part): part is string => part !== null);
  return detail.length === 0 ? null : detail.join(". ");
}
