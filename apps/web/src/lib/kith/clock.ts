// The clock a status route reads, with a test-only override.
//
// `identityCtx` and `workerCtx` (`@repo/kith-store`) both default their `now`
// parameter to `Date.now()`, read once per transaction so a whole operation
// sees one frozen instant -- the same reason `ctx.now` exists at all rather
// than every statement calling `Date.now()` itself. A worker-status read
// applies the read-time staleness predicate (`workers.watcherStaleness`,
// P2-39j) against that instant, and a test asserting `stale: false` on one
// side of `WORKER_HEARTBEAT_OVERDUE_MS` and `stale: true` on the other needs
// that instant fixed for the whole call rather than read from the real clock
// mid-test.
//
// This mirrors `pool.ts`'s `setKithPool`: one module-scoped override,
// restorable, that nothing in the app itself calls. A route always gets
// `Date.now()` in production; only a test that imports `setKithNow` can move
// it.

let overrideNow: number | undefined;

/** The current instant a status route should treat as "now". */
export function kithNow(): number {
  return overrideNow ?? Date.now();
}

/**
 * Test-only: fixes `kithNow()` to `next`, returning a function that restores
 * the previous value. `undefined` restores the real clock.
 */
export function setKithNow(next: number | undefined): () => void {
  const previous = overrideNow;
  overrideNow = next;
  return () => {
    overrideNow = previous;
  };
}
