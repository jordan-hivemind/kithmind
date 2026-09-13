/**
 * Minimal RFC 4180 CSV writer for the COPY loader. Postgres's `COPY ... WITH
 * (FORMAT csv)` reads an unquoted empty field as SQL NULL and a quoted empty
 * field (`""`) as an empty string, so `null`/`undefined` and `""` must stay
 * distinguishable here.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value === "") return '""';
  if (/[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function csvRow(values: (string | null | undefined)[]): string {
  return values.map(csvCell).join(",");
}
