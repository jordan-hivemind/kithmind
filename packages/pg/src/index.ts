// Postgres helpers both schemas in the one database share.
//
// The consolidation plan (docs/plans/2026-09-12-postgres-consolidation.md,
// sections 2.1 and 2.8) puts the brain in a `kith` schema beside `finance` in
// the same database. Three pieces of the finance archive were already
// per-schema rather than finance-specific, so they moved here instead of being
// copied: the nested transaction that pins `search_path` inside the
// transaction, the NUMERIC input and output validation, and the reader role.
//
// Nothing here reads an environment variable or defaults a connection string.
// Each caller supplies its own schema name and its own connection.

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
} from "./decimal.js";
export {
  fromNumericText,
  NUMERIC_MAX_DIGITS,
  NUMERIC_MAX_SCALE,
  toNumericText,
} from "./numeric.js";
export {
  applyReaderRole,
  READER_CONNECTION_LIMIT,
  READER_IDLE_TRANSACTION_TIMEOUT_MS,
  READER_LOCK_TIMEOUT_MS,
  READER_ROLE_LOCK_KEY,
  READER_STATEMENT_TIMEOUT_MS,
  readerRoleName,
  type ReaderRoleOptions,
  type ReaderRoleSummary,
} from "./readerRole.js";
export {
  assertPgSchemaName,
  inSchemaTransaction,
  pinSchema,
  pinnedSchemaOf,
  withSchemaTransaction,
  type SchemaClient,
  type SchemaTransactionOptions,
} from "./transaction.js";
