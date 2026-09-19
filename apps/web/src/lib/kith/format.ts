// Display formatting shared by the app pages' tables.

/** `meeting_note` to `meeting note`. */
export function label(value: string): string {
  return value.replaceAll("_", " ");
}

/** A timestamp as `YYYY-MM-DD`, or empty for none. */
export function shortDate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return new Date(value).toISOString().slice(0, 10);
}
