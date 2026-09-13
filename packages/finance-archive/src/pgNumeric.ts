// Moved to `@repo/pg` (P2-39a): the brain schema lands beside `finance` in the
// same database under the same NUMERIC policy, so the validation is shared
// rather than copied. Re-exported here so every caller in this package, and
// this package's own public surface, keep the import they already had.

export {
  fromNumericText,
  NUMERIC_MAX_DIGITS,
  NUMERIC_MAX_SCALE,
  toNumericText,
} from "@repo/pg";
