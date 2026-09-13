import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import {
  GENERATED_KITH_ID_LENGTH,
  KITH_ID,
  KITH_SCHEMA,
  ProofError,
  addSyntheticApiKey,
  assertKithId,
  newKithId,
  spacePredicate,
} from "../dist/index.js";
import { readerRoleName } from "@repo/pg";

// P2-39d: `validateStageGenerationInput` and its fixture-driven tests
// (Unicode codepoint citations, exact page hashes, the financial-amount
// contract) were retired with the rest of `PostgresProof`'s document
// surface -- migration 005 drops the tables they exercised. The same
// UTF-16-boundary and quote-hash invariants are proved against the real
// schema by test/provenance.test.mjs instead.

test("non-string API keys fail closed before database access", async () => {
  const owner = {
    query() {
      throw new Error("database_should_not_be_called");
    },
  };
  await assert.rejects(
    addSyntheticApiKey(owner, randomUUID(), null),
    (error) => error instanceof ProofError && error.code === "invalid_api_key",
  );
});

// The id convention and the space predicate, with no database. The same rules
// are asserted against a real server in kithSchema.test.mjs, which skips where
// none is configured -- these do not, so a public clone still runs them.

test("a generated id is opaque, one shape, and never repeats", () => {
  const ids = Array.from({ length: 256 }, newKithId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(id.length, GENERATED_KITH_ID_LENGTH);
    assert.match(id, KITH_ID);
    assert.equal(assertKithId(id), id);
  }
});

test("assertKithId refuses anything that is not an id", () => {
  for (const value of [
    "",
    "short",
    "A".repeat(26),
    "a".repeat(19),
    "a".repeat(65),
    "has-a-dash-in-it-somewhere",
    "../../etc/passwd",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.throws(
      () => assertKithId(value),
      (error) => error instanceof ProofError && error.code === "invalid_id",
    );
  }
});

test("the space predicate is one parameter, deduplicated, and denies an empty set", () => {
  const spaceA = newKithId();
  const spaceB = newKithId();
  assert.deepEqual(spacePredicate([spaceA], 3), {
    sql: "space_id = ANY($3::text[])",
    value: [spaceA],
  });
  assert.deepEqual(spacePredicate([spaceB, spaceA, spaceB], 1, "d.space_id"), {
    sql: "d.space_id = ANY($1::text[])",
    value: [spaceA, spaceB].sort(),
  });
  for (const [args, code] of [
    [[[], 1], "unauthorized"],
    [[[spaceA], 0], "invalid_parameter_index"],
    [[[spaceA], 1.5], "invalid_parameter_index"],
    [[[spaceA], 1, "space_id) OR (true"], "invalid_space_column"],
    [[[spaceA, "not an id"], 1], "invalid_space_id"],
  ]) {
    assert.throws(
      () => spacePredicate(...args),
      (error) => error instanceof ProofError && error.code === code,
    );
  }
});

test("the brain schema derives kith_reader through the shared reader role", () => {
  assert.equal(KITH_SCHEMA, "kith");
  assert.equal(readerRoleName(KITH_SCHEMA), "kith_reader");
});
