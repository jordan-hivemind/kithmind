// The space predicate every space-scoped read passes through.
//
// Section 2.5 of docs/plans/2026-09-12-postgres-consolidation.md keeps space
// isolation in application code: one helper resolves the authorized space set
// once per request and every statement carries `space_id = ANY($n)`. Row level
// security is deliberately deferred, so this predicate is the boundary, not a
// convenience -- which is why it is one function rather than a string each
// caller writes, and why the identified risk in the plan ("a space predicate is
// forgotten on one of hundreds of statements") is mitigated by there being
// exactly one thing to grep for.
//
// Two rules are worth stating because both are silent failures if reversed:
//
//   - An empty authorized set denies. It never produces a predicate that
//     matches every row, and it never produces no predicate at all.
//   - Every id is validated, so a caller-supplied space cannot widen authority
//     by arriving as something other than an id.
//
// The schema's own composite `UNIQUE (id, space_id)` and composite foreign keys
// are the second half of the guarantee: they make a cross-space reference
// unrepresentable rather than merely unqueried.

import { assertKithId } from "./ids.js";
import { ProofError } from "./errors.js";

/** A column reference: `space_id`, or `documents.space_id` / `d.space_id`. */
const COLUMN = /^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/;

export type SpacePredicate = {
  /** SQL to drop into a WHERE clause. Already parameterized. */
  readonly sql: string;
  /** The single value to bind at `parameterIndex`. */
  readonly value: readonly string[];
};

/**
 * `space_id = ANY($n::text[])` over the authorized space set, with the array to
 * bind at `$n`.
 *
 * One bind parameter whatever the set's size, so a request authorized for one
 * space and a request authorized for twelve produce the same statement text and
 * the same plan.
 */
export function spacePredicate(
  authorizedSpaceIds: readonly string[],
  parameterIndex: number,
  column = "space_id",
): SpacePredicate {
  if (!Number.isSafeInteger(parameterIndex) || parameterIndex < 1) {
    throw new ProofError("invalid_parameter_index");
  }
  if (!COLUMN.test(column)) throw new ProofError("invalid_space_column");
  if (!Array.isArray(authorizedSpaceIds) || authorizedSpaceIds.length === 0) {
    // Not an empty predicate and not `false`: a caller that reaches a read with
    // no authorized space has an authorization bug, and returning zero rows
    // would hide it behind an empty result.
    throw new ProofError("unauthorized");
  }
  const unique = [
    ...new Set(
      authorizedSpaceIds.map((id) => assertKithId(id, "invalid_space_id")),
    ),
  ].sort();
  return {
    sql: `${column} = ANY($${parameterIndex}::text[])`,
    value: unique,
  };
}
