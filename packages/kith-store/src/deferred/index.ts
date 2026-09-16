// `@repo/kith-store/deferred`: section 2.6's daemon-side building blocks.
//
// `schedule`/`claim`/`complete`/`fail` are the generic queue (`core.ts`).
// `sweeps.ts` is the three periodic Convex crons this row keeps as bounded,
// idempotent sweeps. `drain.ts` and `tick.ts` are what
// `packages/kith-store/src/deferred/cli.ts` calls on an interval. The
// diagnostics half of this row -- the read-time staleness predicate, the
// daily incident writer and the watcher reset -- lives in
// `../workers/diagnostics.js` instead, beside the heartbeat and status
// functions it extends.

export * from "./core.js";
export * from "./registry.js";
export * from "./drain.js";
export * from "./tick.js";
export * from "./sweeps.js";
