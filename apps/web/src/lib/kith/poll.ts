// The live-surface poll design (plan section 5), as one pure state machine.
//
// This project's vitest config has no jsdom, so a hook that touches
// `document.visibilityState`, `fetch` or `setInterval` cannot be rendered and
// exercised directly. Every decision that design actually depends on --
// whether a hidden tab polls, and what a poll's outcome does to the
// displayed value -- lives here instead, in functions that take their inputs
// as arguments and return a new state, so `poll.test.ts` can check them
// without a DOM. `use-status-poll.ts` is the thin, untested wrapper that
// calls these from a `useEffect`.

/** One poll attempt's result. */
export type PollOutcome<T> = { ok: true; value: T } | { ok: false };

export type PollState<T> = {
  value: T;
  /**
   * True when the most recent poll failed and `value` is a carried-over last
   * good value rather than a fresh one. A component shows this as a mild
   * "possibly stale" marker; it never blanks the panel, because a heartbeat
   * or a stat that disappears on a network blip reads as a dead worker or an
   * empty space.
   */
  possiblyStale: boolean;
};

/**
 * Whether a poll should run right now. A hidden tab does not poll (plan
 * section 5); any other `document.visibilityState` value does, including one
 * this function does not recognize, so an unknown state fails open to
 * polling rather than silently going quiet.
 */
export function shouldPoll(visibilityState: string): boolean {
  return visibilityState !== "hidden";
}

/**
 * The state after one poll attempt. A successful fetch replaces the value
 * and clears the stale flag. A failed fetch keeps the current value exactly
 * as it was and flags it possibly stale -- it never falls back to some other
 * default, because the last good value is the only trustworthy thing to show.
 */
export function nextPollState<T>(
  current: PollState<T>,
  outcome: PollOutcome<T>,
): PollState<T> {
  if (outcome.ok) return { value: outcome.value, possiblyStale: false };
  return { value: current.value, possiblyStale: true };
}
