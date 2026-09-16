// The handler registry `drain` runs a claimed job's `kind` through.
//
// This is the seam the plan's daemon design names: "the registry is how g2's
// embedding fill and the card queue hook in later". A handler is registered
// once, by whichever row ports the domain it belongs to, and `drain` never
// needs to know what a handler does -- only whether one is registered for the
// kind it just claimed.

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
