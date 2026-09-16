// Narrative capture's admission gate, once, for every PostgreSQL caller.
//
// The MCP tool (`lib/mcp/writes.ts`) and the web Quick Capture button are the
// same pipeline with two differences the Convex originals also had:
// `mcpActions.capture` checks that the credential carries both `read` and
// `write` before it does anything else, and `publicActions.capture` supplies
// `sourceType: "user_confirmed"` because a person typed the words into their
// own browser. Everything between those two ends is identical, so it lives
// here rather than twice.
//
// ## The transaction shape
//
// Section 4.4 of docs/plans/2026-09-16-web-mcp-postgres-surface.md forbids
// holding a `pg` connection across an outbound HTTP call, and this gate makes
// two of them. So a capture is three transactions, not one:
//
// | # | Isolation                    | What it does                                                        |
// | - | ---------------------------- | ------------------------------------------------------------------- |
// | 1 | `SERIALIZABLE`               | Authorize, resolve the destination, run every provider-free branch, read the active index |
// | 2 | `REPEATABLE READ READ ONLY`  | Re-authorize, gather similar memories and covering facts             |
// | 3 | `SERIALIZABLE`               | Re-authorize and apply the decision                                  |
//
// The embedding request happens between 1 and 2, the classification between 2
// and 3. A capture that stops at a provider-free branch -- unknown grounding, a
// derived age, a broad bucket -- costs transaction 1 alone, and so does a
// denial.
//
// Three things about that table are load-bearing.
//
// *Transaction 1 is `SERIALIZABLE`, not read-only.* `resolveWriteSpace` ends in
// `ensurePersonalSpace`, which creates the personal space and its settings row
// when they are missing. A read-only transaction would refuse that with
// SQLSTATE 25006 and turn a first capture into an error. i3's `prepareEmbedQuery`
// can be read-only because a read tool resolves a space *set* and never
// bootstraps one.
//
// *Authorization comes before the provider call.* This is i3's finding, and it
// applies with more force here, because the text sent to the embedding provider
// is the memory itself rather than a search query. A revoked key, a credential
// with no writable destination and content the provider-free branches already
// decline must each cost nothing outbound.
//
// *Transactions 2 and 3 re-authorize.* A key can be revoked or a membership
// removed while the two provider calls are in flight, which is exactly the
// window Convex's second `requireCaptureAccessForAction` exists to close.
// Transaction 3 re-runs `resolveWriteSpace` as well, and passes the destination
// transaction 1 resolved as its explicit argument: that re-runs
// `requireSpaceAccess(write)` against a live principal, and it pins the write to
// the space whose memories the classifier actually saw, rather than letting a
// default-write-space change mid-call land the answer somewhere the gate never
// looked. A caller-supplied `spaceId` reaches a query through `resolveWriteSpace`
// in transaction 1 and nowhere else.
//
// ## Space isolation
//
// Both gate reads run over the resolved destination alone, so nothing from
// another space is put in front of the classifier, and `parseThoughtAnalysis`
// then refuses any cited id that was not in that set. `applyCaptureDecision`
// checks the space again on every id it acts on.
//
// ## When a provider is unavailable
//
// The gate fails closed, as Convex does. `models/thoughts/actions.ts` returns
// `needs_confirmation` with "Memory was not stored because the admission check
// was unavailable" when `analyzeThought` yields nothing, and stores nothing;
// this returns the same words for the same reason, and for an embedding failure
// too. The embedding is part of the admission check here -- it is what finds the
// memories the classifier compares against -- so losing it would silently turn
// every capture into an ADD, which is the opposite of the check's purpose.
// Convex raises on that path instead; raising would be the same for the
// database and worse for the client, because the provider's own message would
// travel with it. The provider-free path stays exactly where Convex has it:
// the branches taken before the classifier is consulted.
//
// A space with no active embedding index is not a failure. It has no vectors to
// compare against, so the gate skips the embedding request entirely and
// classifies against covering facts alone, which is what Convex's own vector
// search returned on a fresh space.
//
// ## Seams
//
// `setCaptureEmbedder` and `setCaptureClassifier` are set the way i3's
// `setMcpEmbedder` is: nothing in the app calls either, and a test that wants a
// stated decision or a failing provider says so rather than standing up an
// endpoint. They are separate from `reads.ts`'s embedder seam because that one
// is private to that module; unifying the two is follow-up work, not a
// behavioral difference.

import { embeddings, memory } from "@repo/kith-store";
import {
  type Principal,
  requireSpaceAccess,
  resolveWriteSpace,
} from "@repo/kith-store/identity";

import type { WithMcpPrincipal } from "@/lib/mcp/principal";

export type CaptureThoughtArgs = {
  spaceId?: string;
  content: string;
  sourceType?: "user_stated" | "user_confirmed" | "assistant_commitment";
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  validFrom?: number;
  validTo?: number;
  isCore?: boolean;
};

export type CaptureThoughtMetadata = {
  type: string;
  topics: string[];
  people: string[];
  actionItems: string[];
  summary: string;
};

export type CaptureThoughtResult = {
  thoughtId?: string;
  metadata: CaptureThoughtMetadata;
  disposition:
    | "stored"
    | "duplicate"
    | "superseded"
    | "corrected"
    | "needs_confirmation"
    | "skipped";
  operationSummary?: string;
};

export type CaptureEmbedder = (text: string) => Promise<{
  vector: readonly number[];
  fingerprint: string;
}>;

/** Re-exported so a caller wires the seam without reaching into the store. */
export type CaptureClassifier = memory.CaptureClassifier;
export type CaptureClassifierInput = memory.CaptureClassifierInput;

let embedder: CaptureEmbedder | undefined;

export function setCaptureEmbedder(next: CaptureEmbedder | undefined) {
  const previous = embedder;
  embedder = next;
  return () => {
    embedder = previous;
  };
}

let classifier: memory.CaptureClassifier | undefined;

export function setCaptureClassifier(
  next: memory.CaptureClassifier | undefined,
) {
  const previous = classifier;
  classifier = next;
  return () => {
    classifier = previous;
  };
}

async function defaultEmbedder(text: string) {
  const result = await embeddings.requestEmbedding(
    text,
    embeddings.loadEmbeddingConfig(process.env),
  );
  return { vector: result.vector, fingerprint: result.fingerprint };
}

async function defaultClassifier(input: memory.CaptureClassifierInput) {
  return await memory.requestCaptureClassification(
    input,
    memory.loadCaptureClassifierConfig(process.env),
  );
}

/** `mcpActions.capture`'s provenance bound, kept verbatim. */
function assertValidProvenance(args: CaptureThoughtArgs): void {
  if (
    (args.observedAt !== undefined && !Number.isFinite(args.observedAt)) ||
    (args.sourceRef !== undefined &&
      (!args.sourceRef.trim() || args.sourceRef.length > 500)) ||
    (args.batchId !== undefined &&
      (!args.batchId.trim() || args.batchId.length > 160))
  ) {
    throw new Error("Invalid memory provenance");
  }
}

function fallbackResult(
  content: string,
  disposition: CaptureThoughtResult["disposition"],
  operationSummary: string,
): CaptureThoughtResult {
  return {
    metadata: toResultMetadata(memory.fallbackThoughtMetadata(content)),
    disposition,
    operationSummary,
  };
}

/**
 * `readonly string[]` in the store, a plain array on the wire. Convex returned
 * mutable arrays and the tools serialize what they are given, so the copy is
 * made here rather than leaking a frozen-looking type into a tool response.
 */
function toResultMetadata(
  value: memory.ThoughtMetadata,
): CaptureThoughtMetadata {
  return {
    type: value.type,
    topics: [...value.topics],
    people: [...value.people],
    actionItems: [...value.actionItems],
    summary: value.summary,
  };
}

/** The unavailable-admission-check answer, used for both provider failures. */
function admissionUnavailable(content: string): CaptureThoughtResult {
  return fallbackResult(
    content,
    "needs_confirmation",
    "Memory was not stored because the admission check was unavailable",
  );
}

type Prepared =
  | { short: CaptureThoughtResult }
  | { destination: string; content: string; fingerprint: string | null };

export type RunCaptureOptions = {
  /**
   * Run inside transaction 1, against the freshly reloaded principal, before
   * the destination is resolved. `mcpActions.capture`'s both-capabilities check
   * is the only caller; the web surface has no equivalent.
   */
  authorize?: (principal: Principal) => void;
};

/**
 * One capture, from an authenticated principal to a stored row or a refusal.
 *
 * See the module comment for the transaction shape and the order it enforces.
 */
export async function runCaptureThought(
  withPrincipal: WithMcpPrincipal,
  args: CaptureThoughtArgs,
  options: RunCaptureOptions = {},
): Promise<CaptureThoughtResult> {
  // Transaction 1. Authorization first, then every branch Convex takes before
  // it spends anything on a provider, then the index this space actually has.
  const prepared = await withPrincipal(
    async ({ ctx, principal }): Promise<Prepared> => {
      options.authorize?.(principal);
      const destination = await resolveWriteSpace(ctx, principal, args.spaceId);
      // `requireCaptureAccessForAction`: both grants on the resolved space.
      // `resolveWriteSpace` already proved `write`; `read` is the half it does
      // not cover, and the repeat of `write` keeps the refusal order identical
      // across the two surfaces.
      await requireSpaceAccess(ctx, principal, destination, "read");
      await requireSpaceAccess(ctx, principal, destination, "write");

      memory.assertValidMemoryValidity(args);
      assertValidProvenance(args);
      const content = memory.normalizeCaptureContent(args.content);

      // A client connected before `sourceType` existed cannot supply it.
      // Absence is ungrounded rather than `user_stated`, which is the
      // laundering this field exists to prevent.
      if (args.sourceType === undefined) {
        return {
          short: fallbackResult(
            content,
            "needs_confirmation",
            "Memory was not stored because its grounding is unknown. Resend with sourceType once the user has stated or confirmed it",
          ),
        };
      }
      const preflight = memory.preflightNarrativeAdmission(content);
      if (preflight) {
        return {
          short: fallbackResult(
            content,
            preflight.action === "ASK" ? "needs_confirmation" : "skipped",
            preflight.action === "ASK"
              ? `Memory was not stored: ${preflight.reason}`
              : `Memory was skipped: ${preflight.reason}`,
          ),
        };
      }

      const targets = await embeddings.getActiveTargets(ctx, [destination]);
      return {
        destination,
        content,
        fingerprint: embeddings.compatibleSearchFingerprint(
          [destination],
          targets,
        ),
      };
    },
  );
  if ("short" in prepared) return prepared.short;
  const { destination, content, fingerprint } = prepared;
  const sourceType = args.sourceType!;

  // The first outbound call, outside every transaction. Skipped outright when
  // the space has no index to search: there is nothing for the vector to find,
  // and the memory never leaves the process.
  let vector: readonly number[] | null = null;
  if (fingerprint) {
    try {
      const embedded = await (embedder ?? defaultEmbedder)(content);
      // The configured profile has to agree with the index, not merely with
      // itself.
      vector = embedded.fingerprint === fingerprint ? embedded.vector : null;
    } catch {
      // Fail closed. Without candidates the classifier would call every
      // duplicate new, which is worse than declining the capture.
      return admissionUnavailable(content);
    }
    if (!vector) return admissionUnavailable(content);
  }

  // Transaction 2. Re-authorized, read-only, and scoped to the one destination
  // so nothing from another space reaches the classifier.
  const gathered = await withPrincipal(
    async ({ ctx, principal }) => {
      await requireSpaceAccess(ctx, principal, destination, "read");
      await requireSpaceAccess(ctx, principal, destination, "write");
      return {
        candidates: vector
          ? await memory.searchCaptureCandidates(ctx, destination, vector)
          : [],
        coveringFacts: await memory.searchCoveringFacts(
          ctx,
          [destination],
          content,
        ),
      };
    },
    { readOnly: true },
  );

  // The second outbound call. `requestCaptureClassification` answers `null`
  // rather than throwing, but the `catch` is not redundant: `analyzeThought`
  // has one for the same reason, the seam accepts any implementation, and a
  // raised provider error would otherwise travel to the client with its own
  // message in it. Every failure is one answer, and it is the fail-closed one.
  let analysis: memory.ThoughtAnalysis | null = null;
  try {
    analysis = await (classifier ?? defaultClassifier)({
      newContent: content,
      sourceType,
      ...(args.validFrom === undefined ? {} : { newValidFrom: args.validFrom }),
      ...(args.validTo === undefined ? {} : { newValidTo: args.validTo }),
      candidates: gathered.candidates,
      coveringFacts: gathered.coveringFacts,
    });
  } catch {
    analysis = null;
  }

  // Transaction 3. Re-authorized once more, because the two calls above are a
  // window in which a key can be revoked, and only then applied.
  return await withPrincipal(async ({ ctx, principal }) => {
    const writeSpace = await resolveWriteSpace(ctx, principal, destination);
    await requireSpaceAccess(ctx, principal, writeSpace, "read");
    await requireSpaceAccess(ctx, principal, writeSpace, "write");
    const outcome = await memory.applyCaptureDecision(
      ctx,
      principal.userId,
      writeSpace,
      {
        content,
        analysis,
        coveringFacts: gathered.coveringFacts,
        sourceType,
        ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
        ...(args.observedAt === undefined
          ? {}
          : { observedAt: args.observedAt }),
        ...(args.batchId === undefined ? {} : { batchId: args.batchId }),
        ...(args.validFrom === undefined ? {} : { validFrom: args.validFrom }),
        ...(args.validTo === undefined ? {} : { validTo: args.validTo }),
        ...(args.isCore === undefined ? {} : { isCore: args.isCore }),
      },
    );
    return {
      ...(outcome.thoughtId === undefined
        ? {}
        : { thoughtId: outcome.thoughtId }),
      metadata: toResultMetadata(outcome.metadata),
      disposition: outcome.disposition,
      ...(outcome.operationSummary === undefined
        ? {}
        : { operationSummary: outcome.operationSummary }),
    };
  });
}

export type WebCaptureArgs = {
  spaceId?: string;
  content: string;
  validFrom?: number;
  validTo?: number;
  isCore?: boolean;
};

/**
 * Quick Capture's core, ported from `thoughts.publicActions.capture`.
 *
 * The one thing it adds to the pipeline is the original's own
 * `sourceType: "user_confirmed"`: a person typed these words into their own
 * browser, which is confirmation by construction, and it is the only place that
 * label may be applied without a client asserting it. The route handler that
 * wraps this is row i5's; see `lib/mcp/writes.ts` and this slice's report.
 */
export async function captureThoughtFromWeb(
  withPrincipal: WithMcpPrincipal,
  args: WebCaptureArgs,
): Promise<CaptureThoughtResult> {
  return await runCaptureThought(withPrincipal, {
    ...(args.spaceId === undefined ? {} : { spaceId: args.spaceId }),
    content: args.content,
    sourceType: "user_confirmed",
    ...(args.validFrom === undefined ? {} : { validFrom: args.validFrom }),
    ...(args.validTo === undefined ? {} : { validTo: args.validTo }),
    ...(args.isCore === undefined ? {} : { isCore: args.isCore }),
  });
}
