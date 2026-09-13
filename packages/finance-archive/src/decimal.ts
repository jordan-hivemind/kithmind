// Moved to `@repo/pg` (P2-39a), where the shared NUMERIC validation that is
// built on it lives. Re-exported here so every caller in this package, and this
// package's own public surface, keep the import they already had.

export {
  addDecimal,
  canonicalizeDecimal,
  compareDecimal,
  formatDecimal,
  isCanonicalDecimal,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  subtractDecimal,
  type Decimal,
} from "@repo/pg";
