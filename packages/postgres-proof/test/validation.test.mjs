import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import {
  ProofError,
  sha256,
  validateStageGenerationInput,
} from "../dist/index.js";

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
