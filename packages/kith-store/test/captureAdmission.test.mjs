// The provider-free admission gate, ported with its functions.
//
// These cases come from
// `packages/convex/convex/models/thoughts/memoryAnalysis.test.ts` ("rejects
// empty or oversized captures before provider calls" and "deterministically
// declines derived ages and broad bootstrap buckets"), plus the
// `fallbackThoughtMetadata` shape that suite only asserted indirectly through
// `parseThoughtAnalysis`. They exist here so that removing `@repo/db` from the
// web dependency tree in row i7 cannot take the content bound or the
// derived-age refusal with it without a red test.
//
// No database. These three functions are pure.

import assert from "node:assert/strict";
import test from "node:test";

import { memory } from "../dist/index.js";

const {
  MAX_CAPTURE_CONTENT_CHARS,
  fallbackThoughtMetadata,
  normalizeCaptureContent,
  preflightNarrativeAdmission,
} = memory;

test("the capture content bound is the Convex one", () => {
  assert.equal(MAX_CAPTURE_CONTENT_CHARS, 2_000);
});

test("rejects empty or oversized captures before provider calls", () => {
  assert.equal(normalizeCaptureContent("  durable fact  "), "durable fact");
  assert.throws(
    () => normalizeCaptureContent("   "),
    /Memory content must contain/,
  );
  assert.throws(
    () => normalizeCaptureContent("x".repeat(MAX_CAPTURE_CONTENT_CHARS + 1)),
    /Memory content must contain/,
  );
  // The boundary itself is admitted, so the bound is a maximum and not an
  // off-by-one that silently refuses a legal capture.
  assert.equal(
    normalizeCaptureContent("x".repeat(MAX_CAPTURE_CONTENT_CHARS)).length,
    MAX_CAPTURE_CONTENT_CHARS,
  );
});

test("deterministically declines derived ages and broad bootstrap buckets", () => {
  const age = preflightNarrativeAdmission("Rowan is 17 years old.");
  assert.equal(age.action, "SKIP");
  assert.match(age.reason, /date_of_birth/);

  const bucket = preflightNarrativeAdmission(
    "About me: founder, investor, sailor, neighborhood blogger, generative artist, and advisor across several unrelated companies.",
  );
  assert.equal(bucket.action, "ASK");
  assert.match(bucket.reason, /broad bucket/);

  assert.equal(
    preflightNarrativeAdmission(
      "AI Brain will use Convex because it provides the database and application functions in one service. The decision keeps the personal deployment simpler.",
    ),
    null,
  );
});

test("a derived age inside a longer bundle is asked about rather than skipped", () => {
  // The two branches of the age rule. A short claim is mostly the age and is
  // skipped; a long one carries other content and has to be atomized instead,
  // which is an ASK. Losing the distinction would silently discard the rest.
  const bundle = preflightNarrativeAdmission(
    [
      "Rowan is 17 years old.",
      "Rowan attends Redwood Academy and rides the number 12 bus.",
      "Rowan's advisor is Dana.",
    ].join(" "),
  );
  assert.equal(bundle.action, "ASK");
  assert.match(bundle.reason, /atomized/);
});

test("bulleted and multi-sentence catalogs are asked about", () => {
  const bulleted = preflightNarrativeAdmission(
    ["- one", "- two", "- three", "- four"].join("\n"),
  );
  assert.equal(bulleted.action, "ASK");

  const manySentences = preflightNarrativeAdmission(
    "One thing. Two things. Three things. Four things. Five things. Six things.",
  );
  assert.equal(manySentences.action, "ASK");

  const oversized = preflightNarrativeAdmission("word ".repeat(300));
  assert.equal(oversized.action, "ASK");
});

test("fallback metadata is the untyped, unextracted shape", () => {
  assert.deepEqual(
    fallbackThoughtMetadata("  The synthetic ledger is reviewed quarterly.  "),
    {
      type: "reference",
      topics: [],
      people: [],
      actionItems: [],
      summary: "The synthetic ledger is reviewed quarterly.",
    },
  );
  assert.equal(fallbackThoughtMetadata("x".repeat(400)).summary.length, 160);
});
