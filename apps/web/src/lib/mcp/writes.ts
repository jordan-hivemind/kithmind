// The write and ingest half of the MCP tool surface, once per backend.
//
// Slice i4 of the web and MCP surface plan moves `remember_fact`,
// `capture_thought` and `ingest_url` onto `@repo/kith-store` under
// `KITH_POSTGRES_SURFACE=postgres`. It is `reads.ts`'s shape for the other
// direction: one method per tool, returning exactly what the Convex function
// returned, so `server.ts` keeps its schemas, its descriptions, its error
// mapping and its formatters and changes only which implementation it calls.
//
// Four rules from the plan are enforced here rather than in the tools:
//
//   * Section 4.2, writes are `SERIALIZABLE` with the bounded retry. Every
//     PostgreSQL method below goes through i2's loader with `readOnly` unset,
//     which is `withKithTransaction`. `run` may therefore execute more than
//     once, so nothing in it may depend on having run before.
//   * Section 4.3, one transaction per tool call. Authorization, destination
//     resolution and the write itself run on one client, so a membership that
//     is revoked mid-call cannot authorize the row that the same call then
//     writes.
//   * Section 3.3, the principal is reloaded inside that transaction and the
//     destination space is resolved from it. A caller-supplied `spaceId` is an
//     argument to `resolveWriteSpace`, never a value passed through it, and
//     `resolveWriteSpace` ends in `requireSpaceAccess`, whose every refusal is
//     the same words -- so a denial cannot tell "no such space" from "not
//     yours", and the response body names no space id.
//   * The capability. `remember_fact` and `capture_thought` need `write`,
//     `ingest_url` needs `ingest`. None of them is checked here by hand except
//     where the Convex original checked it by hand: the authority lives in
//     `requireSpaceAccess`'s `hasCredentialGrant`, which intersects the
//     capability, the credential's space grant and live membership in one
//     place. A second copy of that test in this file would be a second thing
//     to keep true.
//
// What each tool maps to, and where its capability is enforced:
//
// | Tool              | Service                        | Capability gate                                   |
// | ----------------- | ------------------------------ | ------------------------------------------------- |
// | `remember_fact`   | `memory.rememberFact`          | `resolveWriteSpace` -> `requireSpaceAccess(write)` |
// | `capture_thought` | `memory.captureThought`        | the explicit read+write check, then both grants    |
// | `ingest_url`      | `ingestion.enqueueSourceFetch` | `resolveIngestSourceAccount` -> `(ingest)`         |
//
// ## What `capture_thought` does not carry across
//
// `models/thoughts/mcpActions.capture` runs a model-backed admission gate:
// it embeds the content, vector-searches the destination space for similar
// current thoughts, reads the structured facts that already cover the subject,
// and asks a classifier for one of ADD, NOOP, SUPERSEDE, RETRACT, ASK or SKIP,
// which is also where the stored metadata comes from. None of that lane is on
// PostgreSQL: `searchCoveringFacts` and the capture-time vector candidate
// search are not ported, and the classifier is a Convex action. It also cannot
// run inside this call, because an embedding request and a model call are
// outbound HTTP and section 4.4 forbids holding a `pg` connection across one.
//
// So the PostgreSQL lane runs the whole provider-free half of the Convex
// original, in the Convex original's order, and then takes its ADD branch:
// unknown grounding is still refused, `preflightNarrativeAdmission` still
// declines a derived age or a broad bucket, and an admitted capture is stored
// with `fallbackThoughtMetadata` -- which is the metadata Convex itself stores
// on ADD when the classifier returned no analysis.
//
// Five things are missing, and the first is the one that decides whether this
// surface may carry traffic:
//
//  1. **Fail-closed becomes fail-open.** The Convex original is fail-closed. If
//     the classifier is unavailable, errors or returns something unparseable,
//     `actions.ts:300-308` returns `needs_confirmation` with "Memory was not
//     stored because the admission check was unavailable" and writes nothing:
//     no gate, no storage. This lane has no classifier at all and stores
//     unconditionally once the deterministic preflight passes. The same absence
//     that stops Convex storing is what lets this store. That inversion is the
//     gap, not a smaller version of the gate.
//  2. **SKIP for sensitive content is gone.** `classify.ts:95` makes SKIP cover
//     content that is "transient, incidental, derived, speculative, sensitive",
//     and `classify.ts:101-102` names credentials and secrets explicitly. The
//     preflight covers none of that: it knows derived ages, bullet counts,
//     sentence counts and a few broad headings. A password pasted into
//     `capture_thought` is refused on Convex and stored here.
//  3. Duplicates are not detected, so a repeated capture stores a second row.
//  4. A changed fact does not supersede its predecessor, so contradictory
//     memories accumulate as equally current.
//  5. Topics, people, action items and the summary are not extracted; every
//     stored thought is `type: "reference"` with empty lists.
//
// Two published claims are false on this surface while that is true, so both
// are corrected rather than left standing. `tool-policy.ts`'s
// `idempotentHint: true` for `capture_thought` is a claim that repeating a call
// is safe, which (3) makes false: `mcpToolAnnotations` returns
// `idempotentHint: false` for it under `postgres`. The tool description's "The
// admission gate may decline storage or request confirmation. The server
// deduplicates and preserves changed or corrected prior information as linked
// history." is false in its second sentence and overstated in its first, so
// `server.ts` sends a different sentence under `postgres` that says what this
// deployment actually does. Both revert to the Convex wording the moment the
// gate lands, which is the point of doing it at the seam.
//
// This is recorded here, in section 6 row i4 of the surface plan, and on row
// P2-39m of the parent plan, because it blocks the flag flip and a tracker
// reading only the slice row would not see it.

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { ingestion, memory } from "@repo/kith-store";
import {
  requireSpaceAccess,
  resolveWriteSpace,
} from "@repo/kith-store/identity";

import type { WithMcpPrincipal } from "./principal";
import type { ConvexGateway } from "./reads";

/** The value `server.ts` hands over: a datetime is already epoch milliseconds. */
export type FactValueArg =
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "datetime"; value: number }
  | { type: "number"; value: number; unit?: string }
  | { type: "boolean"; value: boolean }
  | { type: "entity"; entity: EntitySelectorArg };

export type EntitySelectorArg = {
  key?: string;
  kind: "person" | "organization" | "project" | "place" | "other";
  name: string;
  aliases?: string[];
};

export type RememberFactArgs = {
  spaceId?: string;
  subject: EntitySelectorArg;
  predicate: string;
  value: FactValueArg;
  sourceType: "user_stated" | "user_confirmed";
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  cardinality: "single" | "multiple";
  changeKind: "changed" | "corrected";
  changeReason?: string;
};

export type RememberFactResult = {
  factId: string;
  statement: string;
  operation: "stored" | "noop" | "superseded" | "corrected";
};

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

export type IngestUrlArgs = {
  spaceId?: string;
  requestId: string;
  source: {
    connector: "mcp-client";
    accountId: string;
    externalId: string;
  };
  url: string;
  title?: string;
};

/** One method per write or ingest tool. `server.ts` formats what these return. */
export type McpWrites = {
  rememberFact(args: RememberFactArgs): Promise<RememberFactResult>;
  captureThought(args: CaptureThoughtArgs): Promise<CaptureThoughtResult>;
  ingestUrl(args: IngestUrlArgs): Promise<unknown>;
};

// ---------------------------------------------------------------------------
// The Convex surface
// ---------------------------------------------------------------------------

export function convexWrites(convex: ConvexGateway): McpWrites {
  return {
    async rememberFact({ spaceId, ...args }) {
      return await convex.mutation(api.models.facts.mcpActions.remember, {
        ...args,
        spaceId: spaceId as Id<"spaces"> | undefined,
      });
    },
    async captureThought({ spaceId, ...args }) {
      return await convex.action(api.models.thoughts.mcpActions.capture, {
        ...args,
        spaceId: spaceId as Id<"spaces"> | undefined,
      });
    },
    async ingestUrl({ spaceId, ...input }) {
      return await convex.mutation(api.models.ingestion.urlQueue.enqueue, {
        input: {
          ...input,
          ...(spaceId === undefined
            ? {}
            : { spaceId: spaceId as Id<"spaces"> }),
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The PostgreSQL surface
// ---------------------------------------------------------------------------

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

export function postgresWrites(withPrincipal: WithMcpPrincipal): McpWrites {
  return {
    async rememberFact({ spaceId, ...args }) {
      // `facts.mcpActions.remember`, statement for statement: reload the
      // credential, resolve one destination, write. `resolveWriteSpace` is the
      // whole authorization -- it ends in `requireSpaceAccess(..., "write")`,
      // which is where the `write` capability, the credential's space grant and
      // live membership are intersected.
      return await withPrincipal(async ({ ctx, principal }) => {
        const destination = await resolveWriteSpace(ctx, principal, spaceId);
        return await memory.rememberFact(
          ctx,
          principal.userId,
          destination,
          args,
        );
      });
    },

    async captureThought(args) {
      return await withPrincipal(
        async ({ ctx, principal }): Promise<CaptureThoughtResult> => {
          // `mcpActions.capture`'s own check, before anything else it does.
          // It is by hand there and by hand here because capture needs *both*
          // capabilities on the destination, which no single
          // `requireSpaceAccess` call expresses.
          if (
            !principal.capabilities.includes("read") ||
            !principal.capabilities.includes("write")
          ) {
            throw new Error(
              "Thought capture requires read and write capabilities",
            );
          }
          const destination = await resolveWriteSpace(
            ctx,
            principal,
            args.spaceId,
          );
          // `requireCaptureAccessForAction`: both grants on the resolved
          // space. `resolveWriteSpace` already proved `write`; `read` is the
          // half it does not cover, and the repeat of `write` is kept so the
          // two surfaces refuse in the same order.
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
              metadata: memory.fallbackThoughtMetadata(content),
              disposition: "needs_confirmation",
              operationSummary:
                "Memory was not stored because its grounding is unknown. Resend with sourceType once the user has stated or confirmed it",
            };
          }
          const preflight = memory.preflightNarrativeAdmission(content);
          if (preflight) {
            return {
              metadata: memory.fallbackThoughtMetadata(content),
              disposition:
                preflight.action === "ASK" ? "needs_confirmation" : "skipped",
              operationSummary:
                preflight.action === "ASK"
                  ? `Memory was not stored: ${preflight.reason}`
                  : `Memory was skipped: ${preflight.reason}`,
            };
          }

          // The ADD branch, with the metadata the Convex original also stores
          // when it has no analysis. See the module comment for the half of
          // the gate that is not ported.
          const metadata = memory.fallbackThoughtMetadata(content);
          const thoughtId = await memory.captureThought(
            ctx,
            principal.userId,
            destination,
            {
              content,
              metadata,
              ...(args.validFrom === undefined
                ? {}
                : { validFrom: args.validFrom }),
              ...(args.validTo === undefined ? {} : { validTo: args.validTo }),
              ...(args.isCore === undefined ? {} : { isCore: args.isCore }),
              sourceType: args.sourceType,
              ...(args.sourceRef === undefined
                ? {}
                : { sourceRef: args.sourceRef.trim() }),
              ...(args.observedAt === undefined
                ? {}
                : { observedAt: args.observedAt }),
              ...(args.batchId === undefined
                ? {}
                : { batchId: args.batchId.trim() }),
              confidence: 1,
            },
          );
          return { thoughtId, metadata, disposition: "stored" };
        },
      );
    },

    async ingestUrl({ spaceId, ...input }) {
      // `ingestion.urlQueue.enqueue`. `enqueueSourceFetch` reloads the
      // principal itself and resolves the destination through
      // `resolveIngestSourceAccount`, which is where the `ingest` capability
      // and the credential's source-account grant are checked; passing the
      // already-reloaded principal keeps both reloads inside this transaction.
      return await withPrincipal(({ ctx, principal }) =>
        ingestion.enqueueSourceFetch(ctx, {
          principal,
          input: {
            ...input,
            ...(spaceId === undefined ? {} : { spaceId }),
          },
        }),
      );
    },
  };
}
