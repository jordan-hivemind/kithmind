// The full/glance depth policy: "There are a vast number of documents that
// support my tax returns that don't need to be indexed in detail, just basic
// metadata about what they are so the MCP knows where to find them if their
// details are called for. Go back as far as we have for the returns
// themselves; the supporting documents can just get a glance." (owner
// requirement, verbatim in spirit).
//
// `full` when the document is itself a tax return or K-1 (those ARE the
// returns the owner wants kept in full, with no year cutoff -- "go back as
// far as we have"), when it lives under the `dropbox-inbox` root alias (new
// mail the owner has not triaged yet gets full treatment until it is filed
// somewhere else), or when it matches an explicit `--full-match` regex.
// Everything else defaults to `glance`: a basic record of what the document
// is, not a full index of its contents. `--depth` overrides this policy
// outright for the whole run.

import type { DocumentKind } from "./classify.js";

export const DEPTHS = ["glance", "full"] as const;
export type Depth = (typeof DEPTHS)[number];

export type DepthOverride = "auto" | Depth;

const FULL_ROOT_ALIAS = "dropbox-inbox";

export type DepthDecisionInput = {
  kind: DocumentKind;
  relativePath: string;
  rootAlias?: string;
  fullMatchPatterns: readonly RegExp[];
  override: DepthOverride;
};

/** Human-readable reason the decision came out the way it did, purely for
 * logging -- not consulted by any caller. */
export type DepthDecision = { depth: Depth; reason: string };

export function decideDepth(input: DepthDecisionInput): DepthDecision {
  if (input.override !== "auto") {
    return { depth: input.override, reason: `--depth ${input.override}` };
  }
  if (input.kind === "tax_return" || input.kind === "k1") {
    return { depth: "full", reason: `kind ${input.kind}` };
  }
  if (input.rootAlias === FULL_ROOT_ALIAS) {
    return { depth: "full", reason: `root alias ${FULL_ROOT_ALIAS}` };
  }
  const matched = input.fullMatchPatterns.find((pattern) => pattern.test(input.relativePath));
  if (matched) {
    return { depth: "full", reason: `--full-match ${matched.source}` };
  }
  return { depth: "glance", reason: "default" };
}

const DEPTH_FINGERPRINT_TAG: Record<Depth, string> = { glance: "+depth=glance", full: "+depth=full" };

/** Folds `depth` into a converter fingerprint so a policy change that raises
 * a document's depth (or, in principle, lowers it) changes the extraction
 * fingerprint, which is what makes `findOrInsertGeneration`
 * (`source_revision_id` + `processing_fingerprint`) mint a new processing
 * generation instead of silently reusing the old one -- see write.ts. The
 * source revision itself already changes too (glance and full extract
 * different text for a multi-page PDF, and `createOrGetRevision`'s identity
 * is `sha256(extracted text)`), so this is defense in depth, not the only
 * thing making promotion work, but it is required for a document whose
 * extracted text happens to be identical at both depths (a one-page PDF, or
 * any non-PDF file) to still mint a new generation when its depth changes. */
export function withDepthFingerprint(converterFingerprint: string, depth: Depth): string {
  return `${converterFingerprint}${DEPTH_FINGERPRINT_TAG[depth]}`;
}

/** The inverse of `withDepthFingerprint`, read back off a stored generation's
 * `extraction_fingerprint` to learn what depth it was ingested at. `null`
 * when the fingerprint predates this package's depth policy (an older
 * generation from before this change) -- callers treat that the same as "no
 * recorded depth", never as glance or full. */
export function depthFromFingerprint(extractionFingerprint: string | null): Depth | null {
  if (extractionFingerprint === null) return null;
  if (extractionFingerprint.endsWith(DEPTH_FINGERPRINT_TAG.full)) return "full";
  if (extractionFingerprint.endsWith(DEPTH_FINGERPRINT_TAG.glance)) return "glance";
  return null;
}
