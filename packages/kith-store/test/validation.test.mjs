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
  sha256,
  spacePredicate,
  validateStageGenerationInput,
} from "../dist/index.js";
import { readerRoleName } from "@repo/pg";

function fixture() {
  const text = "Alpha 😀 total 0.10";
  const quote = "😀 total";
  return {
    requestId: randomUUID(),
    documentExternalId: "synthetic-document",
    sourceContentHash: sha256("synthetic-source"),
    pages: [{ pageNumber: 1, text, textHash: sha256(text) }],
    evidence: [
      {
        ordinal: 0,
        pageNumber: 1,
        startCodepoint: 6,
        endCodepoint: 13,
        quote,
        quoteHash: sha256(quote),
      },
    ],
    chunks: [{ ordinal: 0, evidenceOrdinal: 0, text }],
    financialAttachments: [
      {
        evidenceOrdinal: 0,
        label: "fixture only",
        amount: "0.1",
        currency: "USD",
      },
    ],
  };
}

test("validation binds Unicode codepoint citations and exact page hashes", () => {
  validateStageGenerationInput(fixture());
  const tampered = fixture();
  tampered.evidence[0].startCodepoint = 7;
  assert.throws(
    () => validateStageGenerationInput(tampered),
    (error) =>
      error instanceof ProofError && error.code === "citation_mismatch",
  );
  const wrongHash = fixture();
  wrongHash.pages[0].textHash = sha256("other");
  assert.throws(
    () => validateStageGenerationInput(wrongHash),
    (error) =>
      error instanceof ProofError && error.code === "page_hash_mismatch",
  );
  const outOfBounds = fixture();
  outOfBounds.evidence[0].endCodepoint = 10_000;
  assert.throws(
    () => validateStageGenerationInput(outOfBounds),
    (error) =>
      error instanceof ProofError && error.code === "invalid_evidence_range",
  );
  const extraKey = fixture();
  extraKey.pages[0].unexpected = true;
  assert.throws(
    () => validateStageGenerationInput(extraKey),
    (error) =>
      error instanceof ProofError && error.code === "invalid_page_shape",
  );
  const unrelatedChunk = fixture();
  unrelatedChunk.chunks[0].text = "invented prefix 😀 total invented suffix";
  assert.throws(
    () => validateStageGenerationInput(unrelatedChunk),
    (error) =>
      error instanceof ProofError && error.code === "chunk_citation_mismatch",
  );
});

test("financial fixture uses the shared 38 digit, 18 place canonical contract", () => {
  for (const amount of [
    "0.1234567890123456789",
    "1e3",
    "NaN",
    "Infinity",
    "01.00",
    "0.10",
    "123456789012345678901234567890123456789",
  ]) {
    const input = fixture();
    input.financialAttachments[0].amount = amount;
    assert.throws(
      () => validateStageGenerationInput(input),
      (error) =>
        error instanceof ProofError &&
        error.code === "invalid_financial_amount",
    );
  }
  const unsupportedCurrency = fixture();
  unsupportedCurrency.financialAttachments[0].currency = "AAA";
  assert.throws(
    () => validateStageGenerationInput(unsupportedCurrency),
    (error) => error instanceof ProofError && error.code === "invalid_currency",
  );
});

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
