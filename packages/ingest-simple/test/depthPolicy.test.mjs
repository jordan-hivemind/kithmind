// Synthetic-fixture unit tests for depthPolicy.ts: every branch of
// `decideDepth`'s policy (kind, root alias, --full-match, override), no year
// cutoff anywhere, plus the fingerprint round-trip promotion depends on.

import assert from "node:assert/strict";
import test from "node:test";

import { decideDepth, depthFromFingerprint, withDepthFingerprint } from "../dist/depthPolicy.js";

function decision(overrides = {}) {
  return decideDepth({
    kind: "other",
    relativePath: "Statements/2021/january.pdf",
    fullMatchPatterns: [],
    override: "auto",
    ...overrides,
  });
}

test("decideDepth: full for tax_return and k1 kinds, regardless of path or year", () => {
  assert.equal(decision({ kind: "tax_return" }).depth, "full");
  assert.equal(decision({ kind: "k1" }).depth, "full");
  // A 1998 return under an arbitrary path is still full: no year cutoff.
  assert.equal(
    decision({ kind: "tax_return", relativePath: "old/1998 1040.pdf" }).depth,
    "full",
  );
});

test("decideDepth: glance for every other kind by default", () => {
  assert.equal(decision({ kind: "tax_support" }).depth, "glance");
  assert.equal(decision({ kind: "statement" }).depth, "glance");
  assert.equal(decision({ kind: "other" }).depth, "glance");
});

test("decideDepth: full for the dropbox-inbox root alias, regardless of kind", () => {
  assert.equal(decision({ kind: "other", rootAlias: "dropbox-inbox" }).depth, "full");
  assert.equal(decision({ kind: "statement", rootAlias: "dropbox-inbox" }).depth, "full");
});

test("decideDepth: a different root alias does not trigger full depth", () => {
  assert.equal(decision({ kind: "other", rootAlias: "dropbox" }).depth, "glance");
  assert.equal(decision({ kind: "other", rootAlias: "taxes-archive" }).depth, "glance");
});

test("decideDepth: full when relativePath matches any --full-match pattern", () => {
  assert.equal(
    decision({ kind: "other", fullMatchPatterns: [/^Statements\//] }).depth,
    "full",
  );
  assert.equal(
    decision({
      kind: "other",
      relativePath: "Misc/note.pdf",
      fullMatchPatterns: [/^Statements\//, /\.pdf$/],
    }).depth,
    "full",
  );
});

test("decideDepth: no --full-match pattern matching leaves the default policy in place", () => {
  assert.equal(
    decision({ kind: "other", fullMatchPatterns: [/^Nope\//] }).depth,
    "glance",
  );
});

test("decideDepth: --depth override wins outright, over kind, alias and --full-match", () => {
  assert.equal(decision({ kind: "tax_return", override: "glance" }).depth, "glance");
  assert.equal(decision({ kind: "other", rootAlias: "dropbox-inbox", override: "glance" }).depth, "glance");
  assert.equal(
    decision({ kind: "other", fullMatchPatterns: [/.*/], override: "glance" }).depth,
    "glance",
  );
  assert.equal(decision({ kind: "other", override: "full" }).depth, "full");
});

test("withDepthFingerprint / depthFromFingerprint round-trip, and differ between depths", () => {
  const glance = withDepthFingerprint("pdftotext-poppler@1.2.3", "glance");
  const full = withDepthFingerprint("pdftotext-poppler@1.2.3", "full");
  assert.notEqual(glance, full);
  assert.equal(depthFromFingerprint(glance), "glance");
  assert.equal(depthFromFingerprint(full), "full");
});

test("depthFromFingerprint: null for a fingerprint with no recorded depth", () => {
  assert.equal(depthFromFingerprint("pdftotext-poppler@1.2.3"), null);
  assert.equal(depthFromFingerprint(null), null);
});
