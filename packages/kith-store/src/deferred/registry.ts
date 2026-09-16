// The handler registry `drain` runs a claimed job's `kind` through.
//
// This is the seam the plan's daemon design names: "the registry is how g2's
// embedding fill and the card queue hook in later". A handler is registered
// once, by whichever row ports the domain it belongs to, and `drain` never
// needs to know what a handler does -- only whether one is registered for the
// kind it just claimed.

import { inlineIngestionHandler } from "../ingestion/inlineWork.js";
import type { DeferredCtx, DeferredWorkKind, DeferredWorkRow } from "./core.js";

export type DeferredWorkHandler = (
  ctx: DeferredCtx,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
) => Promise<void>;

export type DeferredWorkRegistry = Map<DeferredWorkKind, DeferredWorkHandler>;

/** An empty registry, for a caller that wants to register its own handlers
 * from scratch rather than start from this package's defaults. */
export function createRegistry(): DeferredWorkRegistry {
  return new Map();
}

/**
 * This package's own handlers: what `kith-deferred-work` drains with, and what
 * a test drains with unless it is asserting the unregistered-kind path.
 *
 * `inline_ingestion` is registered by P2-39e2, the row that ported admission
 * and processing. `recoverInlineIngestion` (`sweeps.ts`) has been enqueuing
 * this kind since P2-39j with nothing to run it; the handler and that sweep
 * agree on one payload shape, `{ workId }`, keyed by the inline work row's id.
 *
 * `embedding_fill` and `card_queue_tick` are still unregistered. Their kinds
 * exist in migration 017's CHECK list so their owning rows can register a
 * handler without a migration, and until then `drain` fails such a job without
 * consuming an attempt rather than retrying a kind nobody serves.
 */
export function defaultRegistry(): DeferredWorkRegistry {
  const registry = createRegistry();
  registry.set("inline_ingestion", inlineIngestionHandler);
  return registry;
}
