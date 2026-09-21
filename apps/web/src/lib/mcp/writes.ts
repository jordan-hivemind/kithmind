// The write and ingest half of the MCP tool surface.
//
// Slice i4 of the web and MCP surface plan moved `remember_fact`,
// `capture_thought` and `ingest_url` onto `@repo/kith-store`, and i7b deleted
// the Convex implementation. It is `reads.ts`'s shape for the other direction:
// one method per tool, returning exactly what the Convex function returned, so
// `server.ts` keeps its schemas, its descriptions, its error mapping and its
// formatters.
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
// ## `capture_thought`'s admission gate
//
// `mcpActions.capture` runs a model-backed gate before it stores anything: it
// embeds the content, vector-searches the destination space for similar current
// memories, reads the structured facts that already cover the subject, and asks
// a classifier for ADD, NOOP, SUPERSEDE, RETRACT, ASK or SKIP -- which is also
// where the stored metadata comes from. That gate makes two outbound calls, and
// section 4.4 forbids holding a `pg` connection across either, so it cannot be
// the one transaction the rule above describes.
//
// It is therefore the one exception, and its shape is authorize, call out,
// re-authorize and apply: one `SERIALIZABLE` transaction that authorizes,
// resolves the destination and runs every provider-free branch; the embedding
// call, which happens only when that destination has a complete thought index;
// one `REPEATABLE READ READ ONLY` transaction that re-authorizes and gathers
// candidates and covering facts from that destination alone; the classification
// call; and one `SERIALIZABLE` transaction that re-authorizes and applies the
// decision. A capture that stops at a provider-free branch, and a denial, still
// cost one transaction. The pipeline lives in `lib/kith/capture.ts`, because the
// web Quick Capture button runs the same one.

import { ingestion, memory } from "@repo/kith-store";
import { resolveWriteSpace } from "@repo/kith-store/identity";

import {
  type CaptureThoughtArgs,
  type CaptureThoughtMetadata,
  type CaptureThoughtResult,
  runCaptureThought,
} from "@/lib/kith/capture";

import type { WithMcpPrincipal } from "./principal";

export type {
  CaptureThoughtArgs,
  CaptureThoughtMetadata,
  CaptureThoughtResult,
};

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
  kind: "person" | "organization" | "project" | "place" | "vehicle" | "other";
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
// The PostgreSQL surface
// ---------------------------------------------------------------------------

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
      // The admission gate, in `lib/kith/capture.ts` because the web Quick
      // Capture button runs the same one. The only thing this surface adds is
      // `mcpActions.capture`'s own capability check, which is by hand there and
      // by hand here because capture needs *both* capabilities on the
      // destination and no single `requireSpaceAccess` call expresses that. It
      // runs inside the gate's first transaction, against the reloaded
      // principal, before the destination is resolved: the original's order.
      return await runCaptureThought(withPrincipal, args, {
        authorize: (principal) => {
          if (
            !principal.capabilities.includes("read") ||
            !principal.capabilities.includes("write")
          ) {
            throw new Error(
              "Thought capture requires read and write capabilities",
            );
          }
        },
      });
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
