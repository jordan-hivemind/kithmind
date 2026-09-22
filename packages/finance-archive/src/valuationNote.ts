/**
 * Morgan Stanley emits this note from a stated Market Value or NAV column.
 * The all-caps section title describes where the row appeared, while the
 * column label and optional dated-lot suffix describe how it was valued.
 * Source locators and stored notes retain the exact section title.
 */
export const GENERATED_VALUATION_NOTE_PATTERN =
  "^(Market Value|NAV) column of the ([A-Z][A-Z0-9 ,&%'/()+^-]{3,}) holdings table(; summed from [1-9][0-9]* dated lots without a printed Total row)?$";

const GENERATED_VALUATION_NOTE = new RegExp(GENERATED_VALUATION_NOTE_PATTERN);

function generatedValuationNoteParts(
  note: string,
): readonly [column: string, lotSuffix: string | null] | null {
  const match = GENERATED_VALUATION_NOTE.exec(note);
  return match === null ? null : [match[1]!, match[3] ?? null];
}

/**
 * A collision-safe comparison key. Literal notes remain byte-exact. Only the
 * section title in the parser-generated grammar is treated as provenance.
 */
export function valuationNoteComparisonKey(note: string | null): string | null {
  if (note === null) return null;
  const generated = generatedValuationNoteParts(note);
  return JSON.stringify(
    generated === null
      ? ["literal_valuation_note_v1", note]
      : ["generated_valuation_note_v1", ...generated],
  );
}

export function valuationNotesEquivalent(
  left: string | null,
  right: string | null,
): boolean {
  return valuationNoteComparisonKey(left) === valuationNoteComparisonKey(right);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const GENERATED_SQL_PATTERN = sqlLiteral(GENERATED_VALUATION_NOTE_PATTERN);
const COLUMN_SQL_PATTERN = sqlLiteral("^(Market Value|NAV)");
const LOT_SUFFIX_SQL_PATTERN = sqlLiteral(
  "(; summed from [1-9][0-9]* dated lots without a printed Total row)$",
);

/**
 * SQL counterpart of `valuationNotesEquivalent`. Arguments are trusted SQL
 * expressions selected by this package, never caller-provided SQL.
 */
export function valuationNotesEquivalentSql(
  leftExpression: string,
  rightExpression: string,
): string {
  return `(${leftExpression} IS NOT DISTINCT FROM ${rightExpression}
    OR (${leftExpression} ~ ${GENERATED_SQL_PATTERN}
      AND ${rightExpression} ~ ${GENERATED_SQL_PATTERN}
      AND substring(${leftExpression} FROM ${COLUMN_SQL_PATTERN})
          = substring(${rightExpression} FROM ${COLUMN_SQL_PATTERN})
      AND substring(${leftExpression} FROM ${LOT_SUFFIX_SQL_PATTERN})
          IS NOT DISTINCT FROM substring(${rightExpression} FROM ${LOT_SUFFIX_SQL_PATTERN})))`;
}
