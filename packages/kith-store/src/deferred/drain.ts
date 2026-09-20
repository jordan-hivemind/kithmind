// The daemon's drain loop: claim one job, run its registered handler, record
// the outcome, repeat up to a bound. This is the half of section 2.6's daemon
// that replaces the ten `scheduler.runAfter` call sites; `tick.ts` is the
// other half, which runs the periodic sweeps first.
//
// Each job is its own transaction (claim, then a second transaction for the
// handler and its outcome), not one long-lived transaction over the whole
// drain: a handler that touches many rows must not hold the claim lock, or
// any lock, for longer than its own work needs, and a crash mid-handler must
// leave the claim's lease -- not an open transaction -- as the only thing to
// recover.
//
// A pooled handler (`registry.ts`) goes one step further and gets no
// transaction at all, because its work includes an outbound call that no `pg`
// connection may be held across. The claim and the outcome are still recorded
// in their own transactions either way, so the queue protocol is identical for
// both scopes.

import type { Pool } from "pg";

import { withKithQueueTransaction, withKithTransaction } from "../schema.js";
import {
  claim,
  complete,
  fail,
  failWithoutAttempt,
  deferredCtx,
  TerminalDeferredWorkError,
  type DeferredWorkRow,
} from "./core.js";
import { isPooledHandler, type DeferredWorkRegistry } from "./registry.js";

export type DrainOutcome =
  | { id: string; kind: string; status: "completed" }
  | { id: string; kind: string; status: "retrying"; nextAttemptAt: number }
  | { id: string; kind: string; status: "exhausted" }
  | { id: string; kind: string; status: "terminal" }
  | { id: string; kind: string; status: "unregistered_kind" };

export type DrainSummary = {
  claimed: number;
  completed: number;
  retrying: number;
  exhausted: number;
  /** Handlers that answered `TerminalDeferredWorkError`: failed on the first
   * run, on purpose, without spending the retry budget. */
  terminal: number;
  unregisteredKind: number;
  outcomes: DrainOutcome[];
};

const DEFAULT_MAX_JOBS = 25;

/**
 * Claims and runs due jobs one at a time, through `registry`, until none
 * remain or `maxJobs` is reached.
 *
 * Two concurrent `drain` calls over the same queue are safe by construction:
 * `claim`'s `FOR UPDATE SKIP LOCKED` guarantees each claimed row goes to
 * exactly one caller, so running `drain` from two daemon processes (or, in a
 * test, two concurrent `Promise.all` calls) processes each job once, never
 * twice and never zero times for a job that was actually due.
 */
export async function drain(
  pool: Pool,
  registry: DeferredWorkRegistry,
  options: { maxJobs?: number; now?: number } = {},
): Promise<DrainSummary> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const summary: DrainSummary = {
    claimed: 0,
    completed: 0,
    retrying: 0,
    exhausted: 0,
    terminal: 0,
    unregisteredKind: 0,
    outcomes: [],
  };
  for (let index = 0; index < maxJobs; index += 1) {
    const now = options.now ?? Date.now();
    const claimed = await withKithQueueTransaction(pool, (client) =>
      claim(deferredCtx(client, now)),
    );
    if (!claimed) break;
    summary.claimed += 1;
    const outcome = await runOne(pool, registry, claimed, options.now);
    summary.outcomes.push(outcome);
    if (outcome.status === "completed") summary.completed += 1;
    else if (outcome.status === "retrying") summary.retrying += 1;
    else if (outcome.status === "exhausted") summary.exhausted += 1;
    else if (outcome.status === "terminal") summary.terminal += 1;
    else summary.unregisteredKind += 1;
  }
  return summary;
}

async function runOne(
  pool: Pool,
  registry: DeferredWorkRegistry,
  job: DeferredWorkRow & { leaseToken: string },
  fixedNow?: number,
): Promise<DrainOutcome> {
  const entry = registry.get(job.kind);
  if (!entry) {
    await withKithQueueTransaction(pool, (client) =>
      failWithoutAttempt(deferredCtx(client, fixedNow ?? Date.now()), {
        id: job.id,
        leaseToken: job.leaseToken,
        error: `no handler registered for deferred work kind "${job.kind}"`,
      }),
    );
    return { id: job.id, kind: job.kind, status: "unregistered_kind" };
  }
  try {
    if (isPooledHandler(entry)) {
      // Nothing is open across this call. The handler owns every transaction
      // its work needs and keeps each one on its own side of the outbound
      // call it makes; see the scope table in `registry.ts`.
      await entry.run(pool, job.payload, job);
    } else {
      // The handler runs its own work in its own transaction(s): it receives a
      // fresh `DeferredCtx` per call rather than sharing the claim's, because a
      // handler that stages many rows needs the same per-statement transaction
      // boundary every other ported service uses, not one transaction sized to
      // the whole job.
      await withKithTransaction(pool, (client) =>
        entry(deferredCtx(client, fixedNow ?? Date.now()), job.payload, job),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A handler that says "this will fail the same way every time" is taken at
    // its word: `failed` now, with the message recorded, and the attempt
    // budget untouched because the work was tried exactly once. See
    // `TerminalDeferredWorkError` in `core.ts` for why a bounded retry is the
    // wrong shape for this class of failure.
    if (error instanceof TerminalDeferredWorkError) {
      await withKithQueueTransaction(pool, (client) =>
        failWithoutAttempt(deferredCtx(client, fixedNow ?? Date.now()), {
          id: job.id,
          leaseToken: job.leaseToken,
          error: message,
        }),
      );
      return { id: job.id, kind: job.kind, status: "terminal" };
    }
    const result = await withKithQueueTransaction(pool, (client) =>
      fail(deferredCtx(client, fixedNow ?? Date.now()), {
        id: job.id,
        leaseToken: job.leaseToken,
        error: message,
      }),
    );
    if (result.status === "retrying") {
      return {
        id: job.id,
        kind: job.kind,
        status: "retrying",
        nextAttemptAt: result.nextAttemptAt,
      };
    }
    return { id: job.id, kind: job.kind, status: "exhausted" };
  }
  await withKithQueueTransaction(pool, (client) =>
    complete(deferredCtx(client, fixedNow ?? Date.now()), {
      id: job.id,
      leaseToken: job.leaseToken,
    }),
  );
  return { id: job.id, kind: job.kind, status: "completed" };
}
